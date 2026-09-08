import { describe, it, expect, vi, afterEach } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import {
  createAuthMiddleware, createRateLimitMiddleware, validateExternalAuthBinding,
  createRequestContextMiddleware, getRequestContext, requestLogger,
} from './middleware.js';
import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type pino from 'pino';
import type { NextFunction, Request, Response } from 'express';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

type ResponseDouble = Pick<Response, 'json' | 'setHeader'> & { status: (code: number) => ResponseDouble };

function createResponseDouble(): ResponseDouble {
  const response: Partial<ResponseDouble> = {};
  response.status = vi.fn(() => response as ResponseDouble);
  response.json = vi.fn();
  response.setHeader = vi.fn();
  return response as ResponseDouble;
}

describe('transport middleware hardening', () => {
  // bound-qdrant-http-runtime task 2.1: the full diagnostic snapshot is
  // exposed at `/health` and now requires auth like every other route —
  // only `/health/ready` (the bounded readiness probe) stays exempt.
  it('bypasses auth for /health/ready even when token is configured', () => {
    process.env.BHGBRAIN_TOKEN = 'secret-token';

    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const config = {
      transport: { http: { bearer_token_env: 'BHGBRAIN_TOKEN' } },
    } as unknown as BrainConfig;
    const middleware = createAuthMiddleware(config, logger);

    const req = { path: '/health/ready', headers: {} } as unknown as Request;
    const res = createResponseDouble() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // strengthen-operational-observability task 1.6: whether a token is
  // configured never changes across requests for one middleware instance,
  // so the "no token configured" condition must log once per instance, not
  // once per request — otherwise a busy loopback deployment logs one
  // `auth_skip` warning per call for the lifetime of the process.
  it('logs auth_skip exactly once per middleware instance, not once per request', () => {
    delete process.env.BHGBRAIN_TOKEN;

    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const config = {
      transport: { http: { bearer_token_env: 'BHGBRAIN_TOKEN' } },
    } as unknown as BrainConfig;
    const middleware = createAuthMiddleware(config, logger);

    // The construction call above already logged once; verify it happened
    // exactly once before any request, then drive several requests through
    // and confirm the count never grows.
    const authSkipCalls = () => (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .filter(call => (call[0] as { event?: string }).event === 'auth_skip');
    expect(authSkipCalls()).toHaveLength(1);

    for (let i = 0; i < 5; i += 1) {
      const req = { path: '/tool/recall', headers: {} } as unknown as Request;
      const res = createResponseDouble() as unknown as Response;
      const next = vi.fn() as unknown as NextFunction;
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    expect(authSkipCalls()).toHaveLength(1);
  });

  it('requires auth for the full diagnostic /health snapshot when a token is configured', () => {
    process.env.BHGBRAIN_TOKEN = 'secret-token';

    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const config = {
      transport: { http: { bearer_token_env: 'BHGBRAIN_TOKEN' } },
    } as unknown as BrainConfig;
    const middleware = createAuthMiddleware(config, logger);

    const req = { path: '/health', headers: {} } as unknown as Request;
    const res = createResponseDouble() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('authenticates a matching bearer token via constant-time comparison', () => {
    process.env.BHGBRAIN_TOKEN = 'a-valid-secret-token';
    const timingSafeEqualSpy = vi.mocked(nodeCrypto.timingSafeEqual);
    timingSafeEqualSpy.mockClear();

    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const config = {
      transport: { http: { bearer_token_env: 'BHGBRAIN_TOKEN' } },
    } as unknown as BrainConfig;
    const middleware = createAuthMiddleware(config, logger);

    const req = {
      path: '/tool/remember',
      headers: { authorization: 'Bearer a-valid-secret-token' },
    } as unknown as Request;
    const res = createResponseDouble() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a same-length invalid token using the constant-time comparison path', () => {
    process.env.BHGBRAIN_TOKEN = 'a-valid-secret-token';
    const timingSafeEqualSpy = vi.mocked(nodeCrypto.timingSafeEqual);
    timingSafeEqualSpy.mockClear();

    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const config = {
      transport: { http: { bearer_token_env: 'BHGBRAIN_TOKEN' } },
    } as unknown as BrainConfig;
    const middleware = createAuthMiddleware(config, logger);

    // Same length as the configured secret, differs only in the last byte —
    // a `!==` short-circuit would return as fast as any other mismatch, but
    // this asserts the actual comparison path used is `timingSafeEqual`.
    const req = {
      path: '/tool/remember',
      headers: { authorization: 'Bearer a-valid-secret-tokeX' },
    } as unknown as Request;
    const res = createResponseDouble() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a different-length invalid token without throwing or invoking timingSafeEqual', () => {
    process.env.BHGBRAIN_TOKEN = 'a-valid-secret-token';
    const timingSafeEqualSpy = vi.mocked(nodeCrypto.timingSafeEqual);
    timingSafeEqualSpy.mockClear();

    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const config = {
      transport: { http: { bearer_token_env: 'BHGBRAIN_TOKEN' } },
    } as unknown as BrainConfig;
    const middleware = createAuthMiddleware(config, logger);

    const req = {
      path: '/tool/remember',
      headers: { authorization: 'Bearer too-short' },
    } as unknown as Request;
    const res = createResponseDouble() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    expect(() => middleware(req, res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    // The length guard fails closed before a constant-time byte comparison
    // is attempted (`timingSafeEqual` throws on unequal-length buffers).
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('rate limits by trusted identity rather than x-client-id header', () => {
    const metrics = { setGauge: vi.fn(), incCounter: vi.fn() } as unknown as MetricsCollector;
    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const config = { security: { rate_limit_rpm: 1 } } as unknown as BrainConfig;
    const middleware = createRateLimitMiddleware(config, logger, metrics);

    const req1 = { ip: '10.0.0.1', headers: { 'x-client-id': 'a' } } as unknown as Request;
    const req2 = { ip: '10.0.0.1', headers: { 'x-client-id': 'b' } } as unknown as Request;
    const res1 = createResponseDouble() as unknown as Response;
    const res2 = createResponseDouble() as unknown as Response;

    middleware(req1, res1, vi.fn());
    middleware(req2, res2, vi.fn());

    expect(res2.status).toHaveBeenCalledWith(429);
    expect(metrics.incCounter).toHaveBeenCalledWith('bhgbrain_rate_limited_total');
  });

  // bound-qdrant-http-runtime task 2.4: the sweep is now an independent
  // timer (not opportunistically piggybacked on request arrival), so this
  // exercises it via fake timers rather than mocking Date.now directly.
  it('evicts expired buckets via the independent sweep timer', () => {
    vi.useFakeTimers();
    try {
      const metricsDouble = { setGauge: vi.fn(), incCounter: vi.fn() };
      const metrics = metricsDouble as unknown as MetricsCollector;
      const config = { security: { rate_limit_rpm: 100, rate_limit_max_buckets: 10_000 } } as unknown as BrainConfig;
      const middleware = createRateLimitMiddleware(config, undefined, metrics);

      const req1 = { ip: '10.0.0.2', headers: {} } as unknown as Request;
      const res1 = createResponseDouble() as unknown as Response;
      middleware(req1, res1, vi.fn());

      // Past both the 60s bucket window and (at least once) the 30s sweep
      // interval, with no further requests in between.
      vi.advanceTimersByTime(65_000);

      const req2 = { ip: '10.0.0.3', headers: {} } as unknown as Request;
      const res2 = createResponseDouble() as unknown as Response;
      middleware(req2, res2, vi.fn());

      const lastGaugeCall = metricsDouble.setGauge.mock.calls[metricsDouble.setGauge.mock.calls.length - 1];
      expect(lastGaugeCall[0]).toBe('bhgbrain_rate_limit_buckets');
      expect(lastGaugeCall[1]).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // bound-qdrant-http-runtime task 2.4: fail-closed capacity policy.
  it('fails closed with 429 for a new client once the bucket map is at capacity', () => {
    const config = { security: { rate_limit_rpm: 100, rate_limit_max_buckets: 2 } } as unknown as BrainConfig;
    const middleware = createRateLimitMiddleware(config);

    const req1 = { ip: '10.2.0.1', headers: {} } as unknown as Request;
    const req2 = { ip: '10.2.0.2', headers: {} } as unknown as Request;
    const req3 = { ip: '10.2.0.3', headers: {} } as unknown as Request;
    const res1 = createResponseDouble() as unknown as Response;
    const res2 = createResponseDouble() as unknown as Response;
    const res3 = createResponseDouble() as unknown as Response;

    middleware(req1, res1, vi.fn());
    middleware(req2, res2, vi.fn());
    middleware(req3, res3, vi.fn());

    expect(res1.status).not.toHaveBeenCalled();
    expect(res2.status).not.toHaveBeenCalled();
    expect(res3.status).toHaveBeenCalledWith(429);

    // An already-bucketed client keeps working — capacity only blocks
    // admitting a genuinely new identity.
    const res1Again = createResponseDouble() as unknown as Response;
    const nextAgain = vi.fn();
    middleware(req1, res1Again, nextAgain);
    expect(nextAgain).toHaveBeenCalledTimes(1);
    expect(res1Again.status).not.toHaveBeenCalled();
  });

  it('fails closed with 400 when no client identity can be derived', () => {
    const metrics = { setGauge: vi.fn(), incCounter: vi.fn() } as unknown as MetricsCollector;
    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const config = { security: { rate_limit_rpm: 100 } } as unknown as BrainConfig;
    const middleware = createRateLimitMiddleware(config, logger, metrics);

    const req = { ip: undefined, headers: {} } as unknown as Request;
    const res = createResponseDouble() as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_INPUT' }) }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'rate_limit_identity_missing' }),
    );
  });

  it('does not share bucket state or a fallback identity between two requests with no derivable IP', () => {
    const config = { security: { rate_limit_rpm: 1 } } as unknown as BrainConfig;
    const middleware = createRateLimitMiddleware(config);

    const req1 = { ip: undefined, headers: {} } as unknown as Request;
    const req2 = { ip: undefined, headers: {} } as unknown as Request;
    const res1 = createResponseDouble() as unknown as Response;
    const res2 = createResponseDouble() as unknown as Response;

    middleware(req1, res1, vi.fn());
    middleware(req2, res2, vi.fn());

    // Both fail closed with 400 (missing identity), never 429 — proving
    // neither request was silently bucketed under a shared 'unknown' key.
    expect(res1.status).toHaveBeenCalledWith(400);
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  it('isolates bucket state between two independently created middleware instances', () => {
    const config = { security: { rate_limit_rpm: 1 } } as unknown as BrainConfig;
    const middlewareA = createRateLimitMiddleware(config);
    const middlewareB = createRateLimitMiddleware(config);

    const req = { ip: '10.0.0.9', headers: {} } as unknown as Request;

    // Exhaust instance A's limit for this client.
    middlewareA(req, createResponseDouble() as unknown as Response, vi.fn());
    const resAOverLimit = createResponseDouble() as unknown as Response;
    middlewareA(req, resAOverLimit, vi.fn());
    expect(resAOverLimit.status).toHaveBeenCalledWith(429);

    // Instance B has never seen this client and is unaffected.
    const resB = createResponseDouble() as unknown as Response;
    const nextB = vi.fn();
    middlewareB(req, resB, nextB);
    expect(nextB).toHaveBeenCalledTimes(1);
    expect(resB.status).not.toHaveBeenCalled();
  });

  it('provides an instance-scoped reset hook that only clears its own buckets', () => {
    const config = { security: { rate_limit_rpm: 1 } } as unknown as BrainConfig;
    const middlewareA = createRateLimitMiddleware(config);
    const middlewareB = createRateLimitMiddleware(config);

    const req = { ip: '10.0.0.10', headers: {} } as unknown as Request;

    middlewareA(req, createResponseDouble() as unknown as Response, vi.fn());
    middlewareB(req, createResponseDouble() as unknown as Response, vi.fn());

    middlewareA.resetForTests();

    // A is reset, so this is the "first" request again for that bucket.
    const resAAfterReset = createResponseDouble() as unknown as Response;
    const nextAAfterReset = vi.fn();
    middlewareA(req, resAAfterReset, nextAAfterReset);
    expect(nextAAfterReset).toHaveBeenCalledTimes(1);
    expect(resAAfterReset.status).not.toHaveBeenCalled();

    // B was never reset and already had one request recorded, so this
    // second request exceeds its limit of 1.
    const resBUnaffected = createResponseDouble() as unknown as Response;
    middlewareB(req, resBUnaffected, vi.fn());
    expect(resBUnaffected.status).toHaveBeenCalledWith(429);
  });
});

describe('fail-closed auth startup policy', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('throws when non-loopback binding has no auth token and no opt-in', () => {
    delete process.env.BHGBRAIN_TOKEN;
    const config = {
      transport: { http: { host: '0.0.0.0', bearer_token_env: 'BHGBRAIN_TOKEN' } },
      security: { require_loopback_http: false, allow_unauthenticated_http: false },
    } as unknown as BrainConfig;

    expect(() => validateExternalAuthBinding(config)).toThrow('SECURITY');
  });

  it('succeeds when non-loopback binding has auth token', () => {
    process.env.BHGBRAIN_TOKEN = 'my-secret';
    const config = {
      transport: { http: { host: '0.0.0.0', bearer_token_env: 'BHGBRAIN_TOKEN' } },
      security: { require_loopback_http: false, allow_unauthenticated_http: false },
    } as unknown as BrainConfig;

    expect(() => validateExternalAuthBinding(config)).not.toThrow();
  });

  it('allows unauthenticated when explicitly opted in and logs warning', () => {
    delete process.env.BHGBRAIN_TOKEN;
    const logger = { warn: vi.fn() } as unknown as pino.Logger;
    const config = {
      transport: { http: { host: '0.0.0.0', bearer_token_env: 'BHGBRAIN_TOKEN' } },
      security: { require_loopback_http: false, allow_unauthenticated_http: true },
    } as unknown as BrainConfig;

    expect(() => validateExternalAuthBinding(config, logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'unauthenticated_http' }),
    );
  });

  it('skips auth check for loopback bindings', () => {
    delete process.env.BHGBRAIN_TOKEN;
    const config = {
      transport: { http: { host: '127.0.0.1', bearer_token_env: 'BHGBRAIN_TOKEN' } },
      security: { require_loopback_http: true, allow_unauthenticated_http: false },
    } as unknown as BrainConfig;

    expect(() => validateExternalAuthBinding(config)).not.toThrow();
  });
});

// strengthen-operational-observability task 1.5: request correlation.
describe('createRequestContextMiddleware / getRequestContext / requestLogger', () => {
  function createFakeLogger() {
    const children: Array<{ bindings: Record<string, unknown>; logger: unknown }> = [];
    const logger = {
      warn: vi.fn(), info: vi.fn(), error: vi.fn(),
      child: vi.fn((bindings: Record<string, unknown>) => {
        const childLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), bindings };
        children.push({ bindings, logger: childLogger });
        return childLogger;
      }),
    };
    return { logger: logger as unknown as pino.Logger, children };
  }

  it('generates a fresh request id and stamps it on the response header when none is supplied', () => {
    const { logger } = createFakeLogger();
    const middleware = createRequestContextMiddleware(logger);
    const req = { headers: {}, ip: '127.0.0.1' } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const ctx = getRequestContext(req);
    expect(ctx?.requestId).toEqual(expect.any(String));
    expect(ctx?.requestId.length).toBeGreaterThan(0);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', ctx?.requestId);
  });

  it('reuses an inbound X-Request-Id header instead of generating a new one', () => {
    const { logger } = createFakeLogger();
    const middleware = createRequestContextMiddleware(logger);
    const req = { headers: { 'x-request-id': 'client-supplied-id-123' }, ip: '127.0.0.1' } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(getRequestContext(req)?.requestId).toBe('client-supplied-id-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'client-supplied-id-123');
  });

  it('builds a child logger carrying request_id and client_id, distinct per request', () => {
    const { logger, children } = createFakeLogger();
    const middleware = createRequestContextMiddleware(logger);

    const reqA = { headers: {}, ip: '10.0.0.1' } as unknown as Request;
    const resA = { setHeader: vi.fn() } as unknown as Response;
    middleware(reqA, resA, vi.fn() as unknown as NextFunction);

    const reqB = { headers: {}, ip: '10.0.0.2' } as unknown as Request;
    const resB = { setHeader: vi.fn() } as unknown as Response;
    middleware(reqB, resB, vi.fn() as unknown as NextFunction);

    // Two concurrent-shaped requests produce two distinct child loggers with
    // distinct request_id/client_id bindings — the "concurrent calls can be
    // correlated end to end" requirement: nothing here lets request A's and
    // request B's log lines be confused for each other.
    expect(children).toHaveLength(2);
    expect(children[0]!.bindings.request_id).not.toBe(children[1]!.bindings.request_id);
    expect(children[0]!.bindings.client_id).toBe('10.0.0.1');
    expect(children[1]!.bindings.client_id).toBe('10.0.0.2');

    expect(requestLogger(reqA, logger)).toBe(children[0]!.logger);
    expect(requestLogger(reqB, logger)).toBe(children[1]!.logger);
  });

  it('requestLogger falls back to the process-wide logger for a request the context middleware never saw', () => {
    const { logger } = createFakeLogger();
    const bareReq = {} as Request;
    expect(requestLogger(bareReq, logger)).toBe(logger);
    expect(getRequestContext(bareReq)).toBeUndefined();
  });
});
