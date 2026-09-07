import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DistillationLLMClient, DistillationLLMError, warnIfDistillationDegraded } from './distillation-llm.js';
import type { BrainConfig } from '../config/index.js';

function config(): BrainConfig {
  return {
    pipeline: {
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
    },
  } as unknown as BrainConfig;
}

const MEMORIES = [
  { content: 'We deployed via GitHub Actions.', updated_at: '2026-01-01T00:00:00.000Z' },
  { content: 'CI switched to GitHub Actions.', updated_at: '2026-01-02T00:00:00.000Z' },
  { content: 'Actions runner pinned to node20.', updated_at: '2026-01-03T00:00:00.000Z' },
];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('DistillationLLMClient', () => {
  let originalKey: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalKey = process.env.BHGBRAIN_EXTRACTION_API_KEY;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    } else {
      process.env.BHGBRAIN_EXTRACTION_API_KEY = originalKey;
    }
    global.fetch = originalFetch;
  });

  it('succeeds and truncates an oversized summary', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    const longSummary = 'x'.repeat(200);
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({
      choices: [{ message: { content: JSON.stringify({ content: 'We deploy via GitHub Actions.', summary: longSummary }) } }],
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    const result = await client.distill(MEMORIES);

    expect(result.content).toBe('We deploy via GitHub Actions.');
    expect(result.summary.length).toBe(120);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('skips with reason no_key and makes no network call when the key is missing', async () => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    await expect(client.distill(MEMORIES)).rejects.toMatchObject({ reason: 'no_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a non-2xx response as reason llm_error', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => jsonResponse({ error: 'boom' }, false, 500)) as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    const err = await client.distill(MEMORIES).catch(e => e);
    expect(err).toBeInstanceOf(DistillationLLMError);
    expect(err.reason).toBe('llm_error');
  });

  it('surfaces malformed JSON content as reason llm_error', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'not json at all {' } }],
    })) as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    await expect(client.distill(MEMORIES)).rejects.toMatchObject({ reason: 'llm_error' });
  });

  it('surfaces a response missing required fields as reason llm_error', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({ content: 'only content, no summary' }) } }],
    })) as unknown as typeof fetch;

    const client = new DistillationLLMClient(config());
    await expect(client.distill(MEMORIES)).rejects.toMatchObject({ reason: 'llm_error' });
  });

  // unify-llm-client-boundaries task 2.2: previously `distill()` had no
  // AbortController/deadline at all — a hung provider response blocked the
  // call (and, transitively, DistillationScheduler's next tick) forever.
  it('aborts a hung request within retention.distillation.llm_timeout_ms rather than hanging forever', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    global.fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    })) as unknown as typeof fetch;

    const cfg = {
      pipeline: { extraction_model: 'gpt-4o-mini', extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY' },
      retention: { distillation: { llm_timeout_ms: 10 } },
      llm: { retry: { max_attempts: 1, backoff_ms: 1, max_backoff_ms: 1 } },
    } as unknown as BrainConfig;

    const client = new DistillationLLMClient(cfg);
    const start = Date.now();
    const err = await client.distill(MEMORIES).catch(e => e);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(DistillationLLMError);
    expect(err.reason).toBe('llm_error');
    // Bounded by the timeout, not hanging indefinitely — generous margin for
    // CI scheduling jitter, still far below a real hang.
    expect(elapsed).toBeLessThan(2000);
  });

  it('trips the breaker exactly once across a whole failed distill() call', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    global.fetch = vi.fn(async () => jsonResponse({ error: 'boom' }, false, 500)) as unknown as typeof fetch;
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as import('../resilience/index.js').CircuitBreaker;

    const client = new DistillationLLMClient(config(), breaker);
    await expect(client.distill(MEMORIES)).rejects.toBeInstanceOf(DistillationLLMError);

    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });
});

// unify-llm-client-boundaries task 3.2: a startup diagnostic for scheduled
// distillation missing usable credentials.
describe('warnIfDistillationDegraded', () => {
  afterEach(() => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  function cfg(overrides: { enabled: boolean }): BrainConfig {
    return {
      pipeline: { extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY' },
      retention: { distillation: { enabled: overrides.enabled } },
    } as unknown as BrainConfig;
  }

  it('warns when enabled but no key resolves', () => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const logger = { warn: vi.fn() };
    warnIfDistillationDegraded(cfg({ enabled: true }), logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'distillation_degraded_startup' }));
  });

  it('does not warn when disabled', () => {
    const logger = { warn: vi.fn() };
    warnIfDistillationDegraded(cfg({ enabled: false }), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when a key resolves', () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    const logger = { warn: vi.fn() };
    warnIfDistillationDegraded(cfg({ enabled: true }), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
