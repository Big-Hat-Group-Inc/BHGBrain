import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkEntailment, warnIfEntailmentDegraded } from './entailment.js';
import { BrainError } from '../errors/index.js';
import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';
import type { MetricsCollector } from '../health/metrics.js';

function makeConfig(overrides: Partial<BrainConfig['pipeline']> = {}): BrainConfig {
  return {
    pipeline: {
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'TEST_EXTRACTION_API_KEY',
      contradiction_detection: {
        enabled: true,
        timeout_ms: 5000,
      },
      ...overrides,
    },
  } as unknown as BrainConfig;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('checkEntailment', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.TEST_EXTRACTION_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TEST_EXTRACTION_API_KEY;
    vi.useRealTimers();
  });

  it.each(['agree', 'refine', 'contradict'] as const)(
    'round-trips the "%s" label from a mocked fetch response',
    async (label) => {
      global.fetch = vi.fn(async () => jsonResponse({
        choices: [{ message: { content: label } }],
      })) as unknown as typeof fetch;

      const result = await checkEntailment('existing fact', 'candidate fact', makeConfig());

      expect(result).toBe(label);
    },
  );

  it('trims and lowercases the label before matching', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: '  Contradict\n' } }],
    })) as unknown as typeof fetch;

    const result = await checkEntailment('existing', 'candidate', makeConfig());

    expect(result).toBe('contradict');
  });

  it('throws a BrainError when the request times out', async () => {
    global.fetch = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as unknown as typeof fetch;

    await expect(
      checkEntailment('existing', 'candidate', makeConfig({
        extraction_model: 'gpt-4o-mini',
        extraction_model_env: 'TEST_EXTRACTION_API_KEY',
        contradiction_detection: { enabled: true, timeout_ms: 10 },
      })),
    ).rejects.toThrow(BrainError);
  });

  it('throws a BrainError on a non-2xx response', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ error: 'boom' }, 500)) as unknown as typeof fetch;

    await expect(
      checkEntailment('existing', 'candidate', makeConfig()),
    ).rejects.toThrow(BrainError);
  });

  it('throws a BrainError rather than silently coercing a malformed label', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'maybe??' } }],
    })) as unknown as typeof fetch;

    await expect(
      checkEntailment('existing', 'candidate', makeConfig()),
    ).rejects.toThrow(BrainError);
  });

  it('throws a BrainError when the API key env var is unset', async () => {
    delete process.env.TEST_EXTRACTION_API_KEY;
    global.fetch = vi.fn() as unknown as typeof fetch;

    await expect(
      checkEntailment('existing', 'candidate', makeConfig()),
    ).rejects.toThrow(BrainError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws a BrainError on a network error', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    await expect(
      checkEntailment('existing', 'candidate', makeConfig()),
    ).rejects.toThrow(BrainError);
  });

  // unify-llm-client-boundaries task 2.1: entailment now goes through the
  // shared request executor, gaining breaker integration and metrics that
  // did not exist before this migration.
  it('routes the whole call (all internal retry attempts) through a single breaker.execute call', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'agree' } }],
    })) as unknown as typeof fetch;
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;

    const result = await checkEntailment('existing', 'candidate', makeConfig(), breaker);

    expect(result).toBe('agree');
    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });

  it('trips the breaker on a repeated non-2xx response', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ error: 'boom' }, 500)) as unknown as typeof fetch;
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;

    await expect(
      checkEntailment('existing', 'candidate', makeConfig(), breaker),
    ).rejects.toThrow(BrainError);
    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });

  it('records a success counter and histogram on a valid response', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'refine' } }],
    })) as unknown as typeof fetch;
    const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn() } as unknown as MetricsCollector;

    await checkEntailment('existing', 'candidate', makeConfig(), undefined, metrics);

    expect(metrics.incCounter).toHaveBeenCalledWith('entailment_check_total', 1, { result: 'refine' });
    expect(metrics.recordHistogram).toHaveBeenCalledWith('entailment_check_ms', expect.any(Number));
  });

  it('records a failure counter and logs cause telemetry (code/retryable) on a non-2xx response', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ error: 'boom' }, 500)) as unknown as typeof fetch;
    const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn() } as unknown as MetricsCollector;
    const logger = { warn: vi.fn() };

    await expect(
      checkEntailment('existing', 'candidate', makeConfig(), undefined, metrics, logger),
    ).rejects.toThrow(BrainError);

    expect(metrics.incCounter).toHaveBeenCalledWith('entailment_check_failed_total', 1, { code: 'server_error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'entailment_check_failed',
      code: 'server_error',
      retryable: true,
    }));
  });

  it('a malformed label is non-retryable (single fetch call)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'maybe??' } }],
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      checkEntailment('existing', 'candidate', makeConfig()),
    ).rejects.toThrow(BrainError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to OPENAI_API_KEY when extraction_model_env is unset', async () => {
    delete process.env.TEST_EXTRACTION_API_KEY;
    process.env.OPENAI_API_KEY = 'fallback-key';
    global.fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'agree' } }],
    })) as unknown as typeof fetch;

    const result = await checkEntailment('existing', 'candidate', makeConfig());

    expect(result).toBe('agree');
    delete process.env.OPENAI_API_KEY;
  });
});

// unify-llm-client-boundaries task 3.2: a startup diagnostic for
// contradiction detection missing usable credentials, so a misconfigured
// deployment no longer surfaces only as a per-write degraded warning.
describe('warnIfEntailmentDegraded', () => {
  afterEach(() => {
    delete process.env.TEST_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('warns when enabled but no key resolves', () => {
    delete process.env.TEST_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const logger = { warn: vi.fn() };
    warnIfEntailmentDegraded(makeConfig(), logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'entailment_degraded_startup' }));
  });

  it('does not warn when disabled', () => {
    delete process.env.TEST_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const logger = { warn: vi.fn() };
    warnIfEntailmentDegraded(makeConfig({ contradiction_detection: { enabled: false, timeout_ms: 5000 } }), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when a key resolves', () => {
    process.env.TEST_EXTRACTION_API_KEY = 'test-key';
    const logger = { warn: vi.fn() };
    warnIfEntailmentDegraded(makeConfig(), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when only OPENAI_API_KEY is set (documented fallback)', () => {
    delete process.env.TEST_EXTRACTION_API_KEY;
    process.env.OPENAI_API_KEY = 'fallback-key';
    const logger = { warn: vi.fn() };
    warnIfEntailmentDegraded(makeConfig(), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
