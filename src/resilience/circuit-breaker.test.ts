import { describe, expect, it } from 'vitest';
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
});
