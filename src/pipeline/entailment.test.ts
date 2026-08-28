import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkEntailment } from './entailment.js';
import { BrainError } from '../errors/index.js';
import type { BrainConfig } from '../config/index.js';

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
});
