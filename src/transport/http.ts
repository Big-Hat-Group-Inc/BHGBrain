import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server as HttpServer } from 'node:http';
import compression from 'compression';
import type { BrainConfig } from '../config/index.js';
import type { ToolContext } from '../tools/index.js';
import { handleTool } from '../tools/index.js';
import { ResourceHandler } from '../resources/index.js';
import {
  createAuthMiddleware,
  createRateLimitMiddleware,
  createSizeLimitMiddleware,
  createRequestContextMiddleware,
  requestLogger,
  validateLoopbackBinding,
  validateExternalAuthBinding,
  deriveTrustedClientId,
} from './middleware.js';
import { McpSessionManager } from './mcp-http.js';
import type { MetricEntry } from '../health/metrics.js';
import type pino from 'pino';
import { BrainError, ERROR_STATUS, isErrorEnvelope } from '../errors/index.js';
import { toLogError } from '../health/logger.js';

// Prometheus text-exposition label-value escaping: backslash, then quote,
// then newline (order matters so a literal backslash isn't re-escaped).
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const pairs = keys.map(k => `${k}="${escapeLabelValue(labels[k]!)}"`);
  return `{${pairs.join(',')}}`;
}

/**
 * Renders metrics in Prometheus text-exposition form: a `# TYPE` line once
 * per metric name, followed by `name{label="value",...} value` lines (the
 * `{...}` segment omitted when a metric has no labels). Additive relative to
 * the prior plain `name value` output — unlabeled lines are unchanged.
 */
export function renderPrometheusText(metrics: MetricEntry[]): string {
  const lines: string[] = [];
  const typedNames = new Set<string>();

  for (const m of metrics) {
    if (!typedNames.has(m.name)) {
      lines.push(`# TYPE ${m.name} ${m.type}`);
      typedNames.add(m.name);
    }
    lines.push(`${m.name}${formatLabels(m.labels)} ${m.value}`);
  }

  return lines.join('\n');
}

export interface HttpServerHandle {
  app: express.Express;
  mcpSessions: McpSessionManager;
}

// `ERROR_STATUS` (401/400/429/413 consistent with the choices already made
// in middleware.ts, and mcp-http.ts's 404) and `isErrorEnvelope` now live in
// src/errors/index.ts — the one shared definition every transport adapter
// (REST here, MCP in mcp-response.ts/mcp-server.ts, CLI in cli/index.ts)
// imports, instead of each transport carrying its own copy
// (align-runtime-entrypoint-contracts task 2.2).

/**
 * Terminal 4-arg Express error middleware — registered last, after every
 * route. Every HTTP failure path (a thrown/rejected route handler; Express 5
 * forwards a rejected async handler's error here automatically) becomes the
 * structured `{error:{code,message,retryable}}` envelope; no stack trace or
 * HTML ever leaves the process, regardless of `NODE_ENV`
 * (harden-http-server-lifecycle task 3.1).
 */
function createErrorMiddleware(logger: pino.Logger) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    // Per the Express error-handling contract: once headers are sent (e.g. a
    // partially-streamed SSE response), the only safe move is to delegate to
    // the default handler, which closes the connection.
    if (res.headersSent) {
      next(err);
      return;
    }

    // strengthen-operational-observability task 1.5: the request-scoped
    // child logger (carrying `request_id`/`client_id` — see
    // `createRequestContextMiddleware`) when the context middleware ran for
    // this request, so an error surfacing all the way to this terminal
    // handler still correlates back to the request that caused it. Falls
    // back to the process-wide logger for any request that reached here
    // without going through that middleware first (defensive; every real
    // request does).
    const log = requestLogger(req, logger);

    if (err instanceof BrainError) {
      log.warn({ event: 'http_error', code: err.code, path: req.path, err });
      res.status(ERROR_STATUS[err.code]).json(err.toEnvelope());
      return;
    }

    // body-parser (express.json()) tags its own errors with `.type`, not
    // `instanceof BrainError` — map its two request-side failure modes
    // explicitly so they get the same envelope shape as everything else.
    const bodyParserType = (err as { type?: string } | null)?.type;
    if (bodyParserType === 'entity.parse.failed') {
      log.warn({ event: 'http_error', code: 'INVALID_INPUT', path: req.path, message: 'Malformed JSON request body' });
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Malformed JSON request body', retryable: false } });
      return;
    }
    if (bodyParserType === 'entity.too.large') {
      log.warn({ event: 'http_error', code: 'INVALID_INPUT', path: req.path, message: 'Request body too large' });
      res.status(413).json({ error: { code: 'INVALID_INPUT', message: 'Request body too large', retryable: false } });
      return;
    }

    // Anything else is unanticipated: log the real error server-side, but
    // never put its message or stack in the response body.
    log.error({ event: 'http_error', code: 'INTERNAL', path: req.path, err: toLogError(err) });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'An unexpected error occurred', retryable: true } });
  };
}

/**
 * Applies the configured socket timeouts (harden-http-server-lifecycle task
 * 4.1) to the `http.Server` produced by `app.listen(...)` — that call
 * happens in `src/index.ts`, after `createHttpServer` has already returned,
 * so this is a plain property-assignment helper rather than something
 * `createHttpServer` itself can do. Extracted into its own exported function
 * (rather than three inline assignments in `main()`) so the wiring is
 * unit-testable without booting the rest of the server.
 */
export function applyHttpServerTimeouts(httpServer: HttpServer, config: BrainConfig): void {
  httpServer.keepAliveTimeout = config.transport.http.keep_alive_timeout_ms;
  httpServer.headersTimeout = config.transport.http.headers_timeout_ms;
  httpServer.requestTimeout = config.transport.http.request_timeout_ms;
}

/**
 * Binds `app` to `host`/`port` and resolves once the listener is actually
 * ready, rejecting instead of throwing an unhandled `'error'` event if the
 * bind itself fails (most commonly `EADDRINUSE`) — plain `app.listen(...)`
 * returns synchronously before the bind outcome is known, so a caller could
 * only find out about a failed bind by also attaching its own `'error'`
 * listener, which src/index.ts previously did not do at all: an
 * unhandled `'error'` event on an `EventEmitter` throws, crashing the
 * process without a structured log or any chance to close already-opened
 * resources (sqlite, breakers, ...). Callers should `await` this before
 * starting any background scheduler, so background work never starts
 * against a server that never actually came up
 * (align-runtime-entrypoint-contracts task 3.2).
 */
export function listenAsync(app: express.Express, port: number, host: string): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

/**
 * Compression filter (task 5.2): declines any `text/event-stream` response —
 * compression buffers frames, which would stall the `/mcp` SSE stream — and
 * defers to `compression`'s own default filter (respects `Accept-Encoding`,
 * skips tiny/already-compressed bodies) for everything else. Exported so its
 * SSE-vs-everything-else branching is unit-testable without driving a real
 * long-lived SSE response through the app (task 6.4).
 */
export function compressionFilter(req: Request, res: Response): boolean {
  const contentType = res.getHeader('Content-Type');
  if (typeof contentType === 'string' && contentType.startsWith('text/event-stream')) {
    return false;
  }
  return compression.filter(req, res);
}

export function createHttpServer(
  config: BrainConfig,
  ctx: ToolContext,
  resources: ResourceHandler,
  logger: pino.Logger,
): HttpServerHandle {
  validateLoopbackBinding(config);
  validateExternalAuthBinding(config, logger);

  const app = express();

  // strengthen-operational-observability task 1.5: registered before every
  // other middleware (auth, rate limiting, `/health/live` included) so
  // every response — a 401, a 429, a terse liveness check — carries an
  // `X-Request-Id` header and every log line this request produces, however
  // early it fails, can be correlated back to it.
  app.use(createRequestContextMiddleware(logger));

  // Response hygiene (harden-http-server-lifecycle task 5.1): don't
  // advertise the framework, and tell browsers/proxies not to MIME-sniff
  // response bodies. Helmet's remaining value (CSP, COEP, HSTS) is
  // browser-oriented and irrelevant to this JSON/SSE API server.
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Controls how `req.ip` / `req.ips` are derived from `X-Forwarded-For`.
  // Default `false` means the direct socket peer is used (loopback-accurate);
  // enable only behind a trusted reverse proxy that sets forwarding headers.
  app.set('trust proxy', config.security.trust_proxy);

  // Compression (task 5.2): must not buffer the `/mcp` SSE stream, so the
  // filter declines any `text/event-stream` response and defers to the
  // library's default filter (respects `Accept-Encoding`, skips tiny/
  // already-compressed bodies) for everything else.
  app.use(compression({ filter: compressionFilter }));

  app.use(express.json({ limit: config.security.max_request_size_bytes }));

  // bound-qdrant-http-runtime task 2.1/2.2: `/health` (a single unauthenticated
  // route returning the full diagnostic snapshot) is split three ways:
  //  - `/health/live`: terse, unauthenticated, no dependency I/O at all —
  //    registered ahead of every other middleware so it never waits on auth,
  //    rate limiting, or a dependency call. Safe for an orchestrator to poll
  //    at any rate; used for restart decisions (see Docker HEALTHCHECK).
  //  - `/health/ready`: unauthenticated but registered AFTER rate limiting
  //    (below), so repeated public probes cannot start unbounded dependency
  //    requests — `HealthService.checkReadiness()` also caches the Qdrant
  //    probe itself. Required-dependency degradation (SQLite/Qdrant) maps to
  //    503, matching "readiness SHALL fail when required storage is
  //    degraded".
  //  - `/health` (below, after auth): the full diagnostic snapshot —
  //    embedding, retention, schedulers, circuit breakers, etc. — now
  //    requires normal Bearer authentication like every other route, per
  //    "detailed diagnostics SHALL require normal authentication and rate
  //    limiting".
  app.get('/health/live', (_req, res) => {
    res.status(200).json(ctx.health.checkLiveness());
  });

  // Apply middleware
  app.use(createAuthMiddleware(config, logger));
  app.use(createRateLimitMiddleware(config, logger, ctx.metrics));
  app.use(createSizeLimitMiddleware(config));

  app.get('/health/ready', async (_req, res) => {
    const readiness = await ctx.health.checkReadiness();
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  // Authenticated diagnostic snapshot (see split rationale above).
  app.get('/health', async (_req, res) => {
    const health = await ctx.health.check();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(health);
  });

  // Real MCP over HTTP (Streamable HTTP transport): per-session `Server` +
  // `StreamableHTTPServerTransport` pairs registered/looked up through
  // `mcpSessions`, sitting behind the auth/rate-limit/size-limit middleware
  // registered just above — same security posture as the REST endpoints.
  const mcpSessions = new McpSessionManager(ctx, resources, logger);

  app.post('/mcp', async (req, res) => {
    await mcpSessions.handlePost(req, res);
  });

  app.get('/mcp', async (req, res) => {
    await mcpSessions.handleGet(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    await mcpSessions.handleDelete(req, res);
  });

  // Tool endpoint
  app.post('/tool/:name', async (req, res) => {
    // Audit/log client identity is derived from the authenticated principal
    // (`req.ip`, subject to the `trust proxy` setting above) — the same
    // trusted source the rate limiter keys on — never from the
    // caller-supplied `x-client-id` header, which is fully spoofable and is
    // not used to identify the caller for audit purposes. See
    // `add-operations-security-reliability` audit follow-up 2026-06-05,
    // task 4.4.
    const clientId = deriveTrustedClientId(req) ?? 'http-client';
    // req.params.name is passed straight into handleTool with no allowlist
    // of its own — REST intentionally has no separate tool-name registry
    // that could drift from dispatch's own switch in tools/index.ts (see
    // schemas.test.ts's "no separate allowlist" parity test). An unknown
    // name already reaches dispatch's `default: throw invalidInput(...)`
    // and comes back as an INVALID_INPUT envelope; the isErrorEnvelope
    // check below is what makes that a proper non-2xx status instead of
    // always answering 200 (align-runtime-entrypoint-contracts task 2.2/2.3).
    // strengthen-operational-observability task 1.5: the request-scoped
    // child logger, so this call's `tool_call`/`tool_error` events carry
    // `request_id` and correlate back to this exact HTTP request.
    const result = await handleTool(ctx, req.params.name, req.body, clientId, requestLogger(req, ctx.logger));
    // handleTool never throws (BrainError and unexpected errors are both
    // caught and returned as an envelope — see src/tools/index.ts), so every
    // tool failure must be mapped to its HTTP status here explicitly; without
    // this check every classified failure (NOT_FOUND, CONFLICT, ...)
    // previously answered 200 (align-runtime-entrypoint-contracts task 2.2).
    if (isErrorEnvelope(result)) {
      res.status(ERROR_STATUS[result.error.code]).json(result);
      return;
    }
    res.json(result);
  });

  // Resource endpoint
  app.get('/resource', async (req, res) => {
    const uri = req.query.uri as string;
    if (!uri) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'uri query parameter required', retryable: false } });
      return;
    }
    const result = await resources.handle(uri);
    if (isErrorEnvelope(result)) {
      res.status(ERROR_STATUS[result.error.code]).json(result);
      return;
    }
    res.json(result);
  });

  // Metrics endpoint — strengthen-operational-observability task 2.4:
  // registered unconditionally (unlike before, where a disabled
  // `observability.metrics_enabled` meant the route was never registered at
  // all) so an operator probing `/metrics` on a disabled install gets an
  // explicit, explained response instead of Express's generic "Cannot GET
  // /metrics" 404, which is indistinguishable from the route simply not
  // existing (spec: "the response identifies the disabling setting and does
  // not imply the route is unknown"). A one-time startup log line (below)
  // gives the same fact to log-only monitoring that never probes the route.
  if (config.observability.metrics_enabled) {
    app.get('/metrics', (_req, res) => {
      // Histogram families emit `_avg`, `_p50`, `_p95`, `_p99`, `_sample_count`
      // (gauge: current rolling-window occupancy), and `_observations_total`
      // (counter: true monotonic total) lines.
      const metrics = ctx.metrics.getMetrics();
      res.type('text/plain').send(renderPrometheusText(metrics));
    });
  } else {
    logger.info({
      event: 'metrics_disabled',
      message: 'Metrics are disabled (observability.metrics_enabled=false); /metrics returns 503 with this explanation instead of registering the Prometheus endpoint.',
    });
    app.get('/metrics', (_req, res) => {
      res.status(503).json({
        metrics_enabled: false,
        message: 'Metrics are disabled by configuration (observability.metrics_enabled=false in config.json). ' +
          'Set it to true and restart to enable the Prometheus-format /metrics endpoint.',
      });
    });
  }

  // Terminal error middleware: must be registered last (Express identifies
  // error handlers by their 4-argument arity, and only sees the ones
  // registered after the route/middleware that threw).
  app.use(createErrorMiddleware(logger));

  return { app, mcpSessions };
}
