import type { Request, Response, NextFunction } from 'express';
import type { BrainConfig } from '../config/index.js';
import { redactToken } from '../health/logger.js';
import type pino from 'pino';
import type { MetricsCollector } from '../health/metrics.js';

// -- Bearer auth middleware --

export function createAuthMiddleware(config: BrainConfig, logger: pino.Logger) {
  const tokenEnv = config.transport.http.bearer_token_env;
  const expectedToken = process.env[tokenEnv];

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/health') {
      next();
      return;
    }

    if (!expectedToken) {
      logger.warn({ event: 'auth_skip', reason: `No token set in env ${tokenEnv}` });
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
    if (!match || match[1] !== expectedToken) {
      logger.warn({ event: 'auth_failed', token_preview: match?.[1] ? redactToken(match[1]) : 'none' });
      res.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'Invalid bearer token', retryable: false },
      });
      return;
    }

    next();
  };
}

// -- Rate limiting middleware --

const clientBuckets = new Map<string, { count: number; resetAt: number }>();
let lastRateLimitSweepAt = 0;

export function resetRateLimitStateForTests(): void {
  clientBuckets.clear();
  lastRateLimitSweepAt = 0;
}

export function createRateLimitMiddleware(
  config: BrainConfig,
  logger?: pino.Logger,
  metrics?: MetricsCollector,
) {
  const maxRpm = config.security.rate_limit_rpm;

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const windowMs = 60_000;
    const sweepEveryMs = 30_000;

    if (now - lastRateLimitSweepAt >= sweepEveryMs) {
      for (const [clientId, bucket] of clientBuckets.entries()) {
        if (now >= bucket.resetAt) {
          clientBuckets.delete(clientId);
        }
      }
      lastRateLimitSweepAt = now;
    }

    const trustedClientId = req.ip ?? 'unknown';
    const clientHint = req.headers['x-client-id'] as string | undefined;

    let bucket = clientBuckets.get(trustedClientId);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
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
  };
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
      `(env: ${tokenEnv}). Either set ${tokenEnv} or explicitly opt in to unauthenticated mode ` +
      `with security.allow_unauthenticated_http=true.`,
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
