import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAuthMiddleware, createRateLimitMiddleware, resetRateLimitStateForTests, validateExternalAuthBinding } from './middleware.js';

describe('transport middleware hardening', () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
  });

  it('bypasses auth for /health even when token is configured', () => {
    process.env.BHGBRAIN_TOKEN = 'secret-token';

    const logger = { warn: vi.fn() } as any;
    const middleware = createAuthMiddleware({
      transport: { http: { bearer_token_env: 'BHGBRAIN_TOKEN' } },
    } as any, logger);

    const req = { path: '/health', headers: {} } as any;
    const res = { status: vi.fn(() => res), json: vi.fn() } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rate limits by trusted identity rather than x-client-id header', () => {
    const metrics = { setGauge: vi.fn(), incCounter: vi.fn() } as any;
    const logger = { warn: vi.fn() } as any;
    const middleware = createRateLimitMiddleware({ security: { rate_limit_rpm: 1 } } as any, logger, metrics);

    const req1 = { ip: '10.0.0.1', headers: { 'x-client-id': 'a' } } as any;
    const req2 = { ip: '10.0.0.1', headers: { 'x-client-id': 'b' } } as any;
    const res1 = { status: vi.fn(() => res1), json: vi.fn(), setHeader: vi.fn() } as any;
    const res2 = { status: vi.fn(() => res2), json: vi.fn(), setHeader: vi.fn() } as any;

    middleware(req1, res1, vi.fn());
    middleware(req2, res2, vi.fn());

    expect(res2.status).toHaveBeenCalledWith(429);
    expect(metrics.incCounter).toHaveBeenCalledWith('bhgbrain_rate_limited_total');
  });

  it('evicts expired buckets over time', () => {
    const metrics = { setGauge: vi.fn(), incCounter: vi.fn() } as any;
    const middleware = createRateLimitMiddleware({ security: { rate_limit_rpm: 100 } } as any, undefined, metrics);

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(0);

    const req1 = { ip: '10.0.0.2', headers: {} } as any;
    const res1 = { status: vi.fn(() => res1), json: vi.fn(), setHeader: vi.fn() } as any;
    middleware(req1, res1, vi.fn());

    now.mockReturnValue(61_000);
    const req2 = { ip: '10.0.0.3', headers: {} } as any;
    const res2 = { status: vi.fn(() => res2), json: vi.fn(), setHeader: vi.fn() } as any;
    middleware(req2, res2, vi.fn());

    const lastGaugeCall = metrics.setGauge.mock.calls[metrics.setGauge.mock.calls.length - 1];
    expect(lastGaugeCall[0]).toBe('bhgbrain_rate_limit_buckets');
    expect(lastGaugeCall[1]).toBe(1);

    now.mockRestore();
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
    } as any;

    expect(() => validateExternalAuthBinding(config)).toThrow('SECURITY');
  });

  it('succeeds when non-loopback binding has auth token', () => {
    process.env.BHGBRAIN_TOKEN = 'my-secret';
    const config = {
      transport: { http: { host: '0.0.0.0', bearer_token_env: 'BHGBRAIN_TOKEN' } },
      security: { require_loopback_http: false, allow_unauthenticated_http: false },
    } as any;

    expect(() => validateExternalAuthBinding(config)).not.toThrow();
  });

  it('allows unauthenticated when explicitly opted in and logs warning', () => {
    delete process.env.BHGBRAIN_TOKEN;
    const logger = { warn: vi.fn() } as any;
    const config = {
      transport: { http: { host: '0.0.0.0', bearer_token_env: 'BHGBRAIN_TOKEN' } },
      security: { require_loopback_http: false, allow_unauthenticated_http: true },
    } as any;

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
    } as any;

    expect(() => validateExternalAuthBinding(config)).not.toThrow();
  });
});
