import { describe, it, expect, vi, afterEach } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import { createAuthMiddleware, createRateLimitMiddleware, validateExternalAuthBinding } from './middleware.js';
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

type ResponseDouble = Pick<Response, 'status' | 'json' | 'setHeader'>;

function createResponseDouble(): ResponseDouble {
  const response: Partial<ResponseDouble> = {};
  response.status = vi.fn(() => response as ResponseDouble);
  response.json = vi.fn();
  response.setHeader = vi.fn();
  return response as ResponseDouble;
}

describe('transport middleware hardening', () => {
  it('bypasses auth for /health even when token is configured', () => {
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

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
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

  it('evicts expired buckets over time', () => {
    const metrics = { setGauge: vi.fn(), incCounter: vi.fn() } as unknown as MetricsCollector;
    const config = { security: { rate_limit_rpm: 100 } } as unknown as BrainConfig;
    const middleware = createRateLimitMiddleware(config, undefined, metrics);

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(0);

    const req1 = { ip: '10.0.0.2', headers: {} } as unknown as Request;
    const res1 = createResponseDouble() as unknown as Response;
    middleware(req1, res1, vi.fn());

    now.mockReturnValue(61_000);
    const req2 = { ip: '10.0.0.3', headers: {} } as unknown as Request;
    const res2 = createResponseDouble() as unknown as Response;
    middleware(req2, res2, vi.fn());

    const lastGaugeCall = metrics.setGauge.mock.calls[metrics.setGauge.mock.calls.length - 1];
    expect(lastGaugeCall[0]).toBe('bhgbrain_rate_limit_buckets');
    expect(lastGaugeCall[1]).toBe(1);

    now.mockRestore();
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
