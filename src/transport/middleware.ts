import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { BrainConfig } from '../config/index.js';
import { redactToken } from '../health/logger.js';
import type pino from 'pino';
import type { MetricsCollector } from '../health/metrics.js';

/**
 * Constant-time comparison of two strings. Returns false immediately (without
 * calling into `timingSafeEqual`) when the lengths differ, since
 * `timingSafeEqual` throws on unequal-length buffers. The length itself is an
 * inherent, low-value signal that this guard does not attempt to hide.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

// -- Bearer auth middleware --

export function createAuthMiddleware(config: BrainConfig, logger: pino.Logger) {
  const tokenEnv = config.transport.http.bearer_token_env;
  const expectedToken = process.env[tokenEnv];

  // strengthen-operational-observability task 1.6: whether a bearer token is
  // configured is fixed for the lifetime of this middleware instance (it is
  // read from the environment once, above, not re-read per request) — a
  // process-lifetime condition, not a per-request event. Logging it here,
  // once, at middleware construction, instead of inside the request handler
  // below (as it previously did, on every single unauthenticated request)
  // is what the spec's "Default unauthenticated loopback mode serves
  // traffic ... condition is logged once at startup rather than on every
  // request" scenario requires — a busy loopback deployment no longer drowns
  // its warn-level logs in one `auth_skip` line per call.
  if (!expectedToken) {
    logger.warn({ event: 'auth_skip', reason: `No token set in env ${tokenEnv}` });
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // bound-qdrant-http-runtime task 2.1: `/health/live` is registered ahead
    // of this middleware entirely (src/transport/http.ts), so it never
    // reaches here. `/health/ready` stays unauthenticated (a readiness probe
    // is meant to be pollable by an orchestrator with no credentials) but is
    // still registered after this middleware in the route table, so it must
    // be exempted explicitly here rather than by route order. The full
    // diagnostic `/health` snapshot is intentionally NOT exempted any more —
    // it now requires normal Bearer authentication like every other route.
    if (req.path === '/health/ready') {
      next();
      return;
    }

    if (!expectedToken) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'Missing Authorization header', retryable: false },
      });
      return;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || !constantTimeEquals(match[1], expectedToken)) {
      logger.warn({ event: 'auth_failed', token_preview: match?.[1] ? redactToken(match[1]) : 'none' });
      res.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'Invalid bearer token', retryable: false },
      });
      return;
    }

    next();
  };
}

// -- Request context: correlation id + child logger --

const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestContext {
  requestId: string;
  /** Child logger pre-bound with `request_id` and (when derivable) `client_id`. */
  log: pino.Logger;
}

// strengthen-operational-observability task 1.5: keyed on the `Request`
// object itself (never serialized, never leaked to another request) rather
// than a header/query param the handler has to keep threading through every
// call — any downstream code holding the same `req` can recover this
// request's correlation id/child logger via `getRequestContext`.
const REQUEST_CONTEXTS = new WeakMap<Request, RequestContext>();

/**
 * Assigns a per-request correlation id — reusing an inbound `X-Request-Id`
 * header when the caller (or a fronting reverse proxy) already generated
 * one, so a request can be traced across systems, and generating a fresh
 * UUID otherwise — and a child logger pre-bound with that id plus the
 * trusted client identity. Every downstream log for this request (the tool
 * call itself, the terminal error handler) can then share one identifier a
 * concurrent request never collides with (spec: "Request activity SHALL be
 * correlatable end to end").
 *
 * Registered as the very first middleware in `createHttpServer` — ahead of
 * auth, rate limiting, and every route — so even a 401/429/413 rejection
 * carries a correlation id in its response header and log line.
 */
export function createRequestContextMiddleware(logger: pino.Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inbound = req.headers[REQUEST_ID_HEADER];
    const requestId = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();
    const trustedClientId = deriveTrustedClientId(req);
    const log = logger.child({
      request_id: requestId,
      ...(trustedClientId ? { client_id: trustedClientId } : {}),
    });
    REQUEST_CONTEXTS.set(req, { requestId, log });
    res.setHeader('X-Request-Id', requestId);
    next();
  };
}

/** The current request's correlation id + child logger, if the context middleware ran for it. */
export function getRequestContext(req: Request): RequestContext | undefined {
  return REQUEST_CONTEXTS.get(req);
}

/** `getRequestContext(req)?.log`, falling back to `fallback` for a request the context middleware never saw (e.g. a unit test driving a route handler directly). */
export function requestLogger(req: Request, fallback: pino.Logger): pino.Logger {
  return REQUEST_CONTEXTS.get(req)?.log ?? fallback;
}

// -- Rate limiting middleware --

export type RateLimitMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  /** Instance-scoped reset hook for tests. Clears only this middleware's buckets. */
  resetForTests(): void;
};

/**
 * Derive the trusted client identity for rate limiting *and* audit logging.
 * `req.ip` reflects Express's `trust proxy` setting (see `createHttpServer`):
 * with proxy trust disabled it is the direct socket peer, and with it
 * enabled it honors `X-Forwarded-For` from the trusted proxy. This is the
 * only source of client identity that is not attacker-controllable over
 * plain HTTP headers, so both the rate limiter and the audit trail
 * (`src/transport/http.ts`) key on it rather than the caller-supplied
 * `x-client-id` header, which is retained only as a non-authoritative debug
 * hint (see `add-operations-security-reliability` audit follow-up
 * 2026-06-05, task 4.4). When no IP can be derived at all, callers should
 * fail closed rather than collapsing into a shared/spoofable bucket.
 */
export function deriveTrustedClientId(req: Request): string | undefined {
  return req.ip || undefined;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
// bound-qdrant-http-runtime task 2.4: an independent sweep interval, not tied
// to request arrival — bucket cleanup now happens even when traffic from a
// rotating-identity burst stops entirely, instead of only opportunistically
// piggybacking on the next request.
const RATE_LIMIT_SWEEP_INTERVAL_MS = 30_000;
// Fallback used only when a caller constructs a config bypassing Zod
// validation (as several existing unit tests deliberately do) without
// `security.rate_limit_max_buckets` — production configs always have the
// Zod-validated default (10,000) filled in.
const DEFAULT_RATE_LIMIT_MAX_BUCKETS = 10_000;

export function createRateLimitMiddleware(
  config: BrainConfig,
  logger?: pino.Logger,
  metrics?: MetricsCollector,
): RateLimitMiddleware {
  const maxRpm = config.security.rate_limit_rpm;
  const maxBuckets = config.security.rate_limit_max_buckets ?? DEFAULT_RATE_LIMIT_MAX_BUCKETS;
  const clientBuckets = new Map<string, { count: number; resetAt: number }>();

  function sweepExpired(now: number): void {
    for (const [clientId, bucket] of clientBuckets.entries()) {
      if (now >= bucket.resetAt) {
        clientBuckets.delete(clientId);
      }
    }
  }

  // Unref'd so this timer never keeps the process alive on its own (matches
  // every other periodic timer in this codebase, e.g. CleanupScheduler).
  const sweepTimer = setInterval(() => sweepExpired(Date.now()), RATE_LIMIT_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  const middleware = ((req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();

    const clientHint = req.headers['x-client-id'] as string | undefined;
    const trustedClientId = deriveTrustedClientId(req);

    if (!trustedClientId) {
      logger?.warn({ event: 'rate_limit_identity_missing', client_hint: clientHint });
      res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'Unable to determine client identity for rate limiting',
          retryable: false,
        },
      });
      return;
    }

    let bucket = clientBuckets.get(trustedClientId);
    if (!bucket || now >= bucket.resetAt) {
      // bound-qdrant-http-runtime task 2.4: fail-closed capacity policy — a
      // genuinely new client key is only admitted while under the configured
      // hard cap. At capacity, run one last sweep first (an expired bucket
      // may free room without rejecting anyone), and only reject if the map
      // is still full. Rotating identities (spoofed X-Forwarded-For under a
      // trust-all setting, or simply many distinct real clients) therefore
      // cannot grow the map without bound — a request from an *existing*
      // bucket is never rejected this way.
      if (!bucket && clientBuckets.size >= maxBuckets) {
        sweepExpired(now);
        if (clientBuckets.size >= maxBuckets) {
          metrics?.incCounter('bhgbrain_rate_limit_capacity_rejected_total');
          logger?.warn({
            event: 'rate_limit_capacity_exceeded',
            client_hint: clientHint,
            max_buckets: maxBuckets,
          });
          res.status(429).json({
            error: {
              code: 'RATE_LIMITED',
              message: 'Rate limiter is at capacity; try again shortly',
              retryable: true,
            },
          });
          return;
        }
      }
      bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      clientBuckets.set(trustedClientId, bucket);
    }

    bucket.count++;
    metrics?.setGauge('bhgbrain_rate_limit_buckets', clientBuckets.size);

    if (bucket.count > maxRpm) {
      metrics?.incCounter('bhgbrain_rate_limited_total');
      logger?.warn({
        event: 'rate_limited',
        trusted_client_id: trustedClientId,
        client_hint: clientHint,
        limit: maxRpm,
      });
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: `Rate limit exceeded: ${maxRpm} req/min`, retryable: true },
      });
      return;
    }

    res.setHeader('X-RateLimit-Limit', maxRpm.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRpm - bucket.count).toString());
    next();
  }) as RateLimitMiddleware;

  middleware.resetForTests = (): void => {
    clientBuckets.clear();
  };

  return middleware;
}

// -- Request size limit middleware --

export function createSizeLimitMiddleware(config: BrainConfig) {
  const maxBytes = config.security.max_request_size_bytes;

  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > maxBytes) {
      res.status(413).json({
        error: { code: 'INVALID_INPUT', message: `Request body exceeds ${maxBytes} bytes`, retryable: false },
      });
      return;
    }
    next();
  };
}

// -- Loopback enforcement --

export function validateLoopbackBinding(config: BrainConfig): void {
  const host = config.transport.http.host;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  if (!isLoopback && config.security.require_loopback_http) {
    throw new Error(
      `HTTP binding to "${host}" is non-loopback. Set security.require_loopback_http=false to allow.`,
    );
  }
}

// -- Fail-closed auth check for external bindings --

export function validateExternalAuthBinding(config: BrainConfig, logger?: pino.Logger): void {
  const host = config.transport.http.host;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  if (isLoopback) return; // loopback is fine without auth

  const tokenEnv = config.transport.http.bearer_token_env;
  const hasToken = !!process.env[tokenEnv];
  const allowUnauthenticated = config.security.allow_unauthenticated_http ?? false;

  if (!hasToken && !allowUnauthenticated) {
    throw new Error(
      `SECURITY: HTTP binding to "${host}" is externally reachable but no bearer token is configured ` +
      `(env: ${tokenEnv}). To fix this:\n` +
      `  • Set a token:           export ${tokenEnv}="$(openssl rand -hex 24)"\n` +
      `  • In Docker:             the container entrypoint auto-generates ${tokenEnv} and prints it ` +
      `(saved to <data_dir>/bhgbrain-token); pass your own ${tokenEnv} to use a stable value.\n` +
      `  • To run open anyway:    set security.allow_unauthenticated_http=true (NOT recommended for non-loopback).`,
    );
  }

  if (!hasToken && allowUnauthenticated) {
    logger?.warn({
      event: 'unauthenticated_http',
      host,
      message: 'HTTP server is externally reachable WITHOUT authentication. ' +
        'This is explicitly allowed by configuration but is a security risk.',
    });
  }
}
