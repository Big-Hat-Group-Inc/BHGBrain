import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('transitions closed to open and fast-fails while open', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(
      { failureThreshold: 2, openWindowMs: 1_000, halfOpenProbeCount: 1 },
      () => now,
    );

    await expect(breaker.execute(async () => {
      throw new Error('fail-1');
    })).rejects.toThrow('fail-1');

    await expect(breaker.execute(async () => {
      throw new Error('fail-2');
    })).rejects.toThrow('fail-2');

    expect(breaker.getState()).toBe('open');
    await expect(breaker.execute(async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);

    now = 1_001;
    expect(breaker.getState()).toBe('half-open');
  });

  it('closes after enough successful half-open probes', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openWindowMs: 100, halfOpenProbeCount: 2 },
      () => now,
    );

    await expect(breaker.execute(async () => {
      throw new Error('trip');
    })).rejects.toThrow('trip');

    now = 101;
    await expect(breaker.execute(async () => 'probe-1')).resolves.toBe('probe-1');
    expect(breaker.getState()).toBe('half-open');

    await expect(breaker.execute(async () => 'probe-2')).resolves.toBe('probe-2');
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getStats().failures).toBe(0);
  });

  it('reopens when a half-open probe fails', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openWindowMs: 100, halfOpenProbeCount: 1 },
      () => now,
    );

    await expect(breaker.execute(async () => {
      throw new Error('trip');
    })).rejects.toThrow('trip');

    now = 101;
    await expect(breaker.execute(async () => {
      throw new Error('probe-failed');
    })).rejects.toThrow('probe-failed');

    expect(breaker.getState()).toBe('open');
  });

  it('admits a single in-flight half-open probe and fast-fails concurrent callers', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openWindowMs: 100, halfOpenProbeCount: 1 },
      () => now,
    );

    await expect(breaker.execute(async () => {
      throw new Error('trip');
    })).rejects.toThrow('trip');

    now = 101;

    let resolveProbe!: (value: string) => void;
    const probePromise = new Promise<string>((resolve) => {
      resolveProbe = resolve;
    });

    const first = breaker.execute(() => probePromise);

    // Both concurrent callers arrive while the single probe is still in flight.
    await expect(breaker.execute(async () => 'should-not-run')).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(breaker.execute(async () => 'should-not-run-either')).rejects.toBeInstanceOf(CircuitOpenError);

    resolveProbe('probe-ok');
    await expect(first).resolves.toBe('probe-ok');
    expect(breaker.getState()).toBe('closed');
  });

  it('releases the probe gate after a failed half-open probe so a later probe can run', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openWindowMs: 100, halfOpenProbeCount: 1 },
      () => now,
    );

    await expect(breaker.execute(async () => {
      throw new Error('trip');
    })).rejects.toThrow('trip');

    now = 101;
    await expect(breaker.execute(async () => {
      throw new Error('probe-failed');
    })).rejects.toThrow('probe-failed');
    expect(breaker.getState()).toBe('open');

    now = 202;
    await expect(breaker.execute(async () => 'probe-2')).resolves.toBe('probe-2');
    expect(breaker.getState()).toBe('closed');
  });
});

describe('CircuitBreaker transition logging', () => {
  it('logs warn on closed to open with breaker key and failure count', async () => {
    let now = 0;
    const logger = { warn: vi.fn(), info: vi.fn() };
    const breaker = new CircuitBreaker(
      { failureThreshold: 2, openWindowMs: 1_000, halfOpenProbeCount: 1, key: 'test-breaker', logger },
      () => now,
    );

    await expect(breaker.execute(async () => {
      throw new Error('fail-1');
    })).rejects.toThrow('fail-1');
    expect(logger.warn).not.toHaveBeenCalled();

    await expect(breaker.execute(async () => {
      throw new Error('fail-2');
    })).rejects.toThrow('fail-2');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      breaker: 'test-breaker',
      from: 'closed',
      to: 'open',
      failures: 2,
    }));
  });

  it('logs info on open to half-open and half-open to closed transitions', async () => {
    let now = 0;
    const logger = { warn: vi.fn(), info: vi.fn() };
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openWindowMs: 100, halfOpenProbeCount: 1, key: 'k', logger },
      () => now,
    );

    await expect(breaker.execute(async () => {
      throw new Error('trip');
    })).rejects.toThrow('trip');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    now = 101;
    expect(breaker.getState()).toBe('half-open');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      breaker: 'k', from: 'open', to: 'half-open',
    }));

    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      breaker: 'k', from: 'half-open', to: 'closed',
    }));
  });

  it('logs info on half-open to open when a probe fails', async () => {
    let now = 0;
    const logger = { warn: vi.fn(), info: vi.fn() };
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openWindowMs: 100, halfOpenProbeCount: 1, key: 'k', logger },
      () => now,
    );

    await expect(breaker.execute(async () => {
      throw new Error('trip');
    })).rejects.toThrow('trip');

    now = 101;
    await expect(breaker.execute(async () => {
      throw new Error('probe-failed');
    })).rejects.toThrow('probe-failed');

    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      breaker: 'k', from: 'half-open', to: 'open',
    }));
  });

  it('does not throw when no logger is configured', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openWindowMs: 100, halfOpenProbeCount: 1, key: 'k' },
      () => now,
    );

    await expect(breaker.execute(async () => {
      throw new Error('trip');
    })).rejects.toThrow('trip');
    expect(breaker.getState()).toBe('open');
  });
});
