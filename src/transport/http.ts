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
  validateLoopbackBinding,
  validateExternalAuthBinding,
  deriveTrustedClientId,
} from './middleware.js';
import { McpSessionManager } from './mcp-http.js';
import type { MetricEntry } from '../health/metrics.js';
import type pino from 'pino';
import { BrainError } from '../errors/index.js';
import type { ErrorCode } from '../domain/types.js';

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

// Status codes consistent with the choices already made in middleware.ts
// (401/400/429/413) and mcp-http.ts (404), extended to cover the rest of the
// `ErrorCode` union so no BrainError falls through to the generic 500 branch.
const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  AUTH_REQUIRED: 401,
  RATE_LIMITED: 429,
  EMBEDDING_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/**
 * `ResourceHandler.handle` reports failures (unknown scheme, malformed URI —
 * task 3.2) by *returning* an envelope object rather than throwing, since it
 * is also reached from stdio and `/mcp`, which have no HTTP status to set.
 * The `/resource` route below is the one caller that does have a status
 * line, so it detects that shape here and maps it, rather than always
 * answering 200 for a request that actually failed.
 */
function isErrorEnvelope(value: unknown): value is { error: { code: ErrorCode; message: string; retryable: boolean } } {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code in ERROR_STATUS;
}

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

    if (err instanceof BrainError) {
      logger.warn({ event: 'http_error', code: err.code, path: req.path, message: err.message });
      res.status(ERROR_STATUS[err.code]).json(err.toEnvelope());
      return;
    }

    // body-parser (express.json()) tags its own errors with `.type`, not
    // `instanceof BrainError` — map its two request-side failure modes
    // explicitly so they get the same envelope shape as everything else.
    const bodyParserType = (err as { type?: string } | null)?.type;
    if (bodyParserType === 'entity.parse.failed') {
      logger.warn({ event: 'http_error', code: 'INVALID_INPUT', path: req.path, message: 'Malformed JSON request body' });
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Malformed JSON request body', retryable: false } });
      return;
    }
    if (bodyParserType === 'entity.too.large') {
      logger.warn({ event: 'http_error', code: 'INVALID_INPUT', path: req.path, message: 'Request body too large' });
      res.status(413).json({ error: { code: 'INVALID_INPUT', message: 'Request body too large', retryable: false } });
      return;
    }

    // Anything else is unanticipated: log the real error server-side, but
    // never put its message or stack in the response body.
    const error = err as { message?: string; stack?: string } | null;
    logger.error({ event: 'http_error', code: 'INTERNAL', path: req.path, error: error?.message, stack: error?.stack });
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

  // Health endpoint (no auth required)
  app.get('/health', async (_req, res) => {
    const health = await ctx.health.check();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(health);
  });

  // Apply middleware
  app.use(createAuthMiddleware(config, logger));
  app.use(createRateLimitMiddleware(config, logger, ctx.metrics));
  app.use(createSizeLimitMiddleware(config));

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
    const result = await handleTool(ctx, req.params.name, req.body, clientId);
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

  // Metrics endpoint (if enabled)
  if (config.observability.metrics_enabled) {
    app.get('/metrics', (_req, res) => {
      // Histogram families emit `_avg`, `_p50`, `_p95`, `_p99`, and `_count` lines.
      const metrics = ctx.metrics.getMetrics();
      res.type('text/plain').send(renderPrometheusText(metrics));
    });
  }

  // Terminal error middleware: must be registered last (Express identifies
  // error handlers by their 4-argument arity, and only sees the ones
  // registered after the route/middleware that threw).
  app.use(createErrorMiddleware(logger));

  return { app, mcpSessions };
}
