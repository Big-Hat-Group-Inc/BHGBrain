import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAISummarizationProvider,
  DegradedSummarizationProvider,
  createSummarizationProvider,
  warnIfSummarizationDegraded,
} from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';

function createConfig(overrides: Partial<BrainConfig['pipeline']> = {}): BrainConfig {
  return {
    pipeline: {
      summarization_enabled: true,
      summarization_model: 'gpt-4o-mini',
      summarization_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
      summarization_timeout_ms: 3000,
      ...overrides,
    },
  } as unknown as BrainConfig;
}

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe('OpenAISummarizationProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('truncates an over-length model response to maxLen with the "..." convention', async () => {
    const longResponse = 'A'.repeat(200);
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(longResponse)));

    const provider = new OpenAISummarizationProvider(createConfig(), 'test-key');
    const summary = await provider.summarize('some content', 120);

    expect(summary.length).toBe(120);
    expect(summary).toContain('...');
  });

  it('returns the model response verbatim when it is already within maxLen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse('A short summary.')));

    const provider = new OpenAISummarizationProvider(createConfig(), 'test-key');
    const summary = await provider.summarize('some content', 120);

    expect(summary).toBe('A short summary.');
  });

  it('rejects (does not swallow) on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));

    const provider = new OpenAISummarizationProvider(createConfig(), 'test-key');
    await expect(provider.summarize('some content', 120)).rejects.toThrow('Summarization API error 500');
  });

  it('rejects on a fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const provider = new OpenAISummarizationProvider(createConfig(), 'test-key');
    await expect(provider.summarize('some content', 120)).rejects.toThrow('network down');
  });

  it('aborts and rejects within summarization_timeout_ms on a hanging request', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal;
      signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })));

    const provider = new OpenAISummarizationProvider(createConfig({ summarization_timeout_ms: 5 }), 'test-key');
    await expect(provider.summarize('some content', 120)).rejects.toThrow();
  });

  it('invokes the circuit breaker for the chat-completions call', async () => {
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse('A short summary.')));

    const provider = new OpenAISummarizationProvider(createConfig(), 'test-key', breaker);
    await provider.summarize('some content', 120);

    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });
});

describe('DegradedSummarizationProvider', () => {
  it('always rejects without making a network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const provider = new DegradedSummarizationProvider();
    await expect(provider.summarize('content', 120)).rejects.toThrow('missing API credentials');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('createSummarizationProvider', () => {
  afterEach(() => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
  });

  it('returns undefined when summarization_enabled is false', () => {
    const provider = createSummarizationProvider(createConfig({ summarization_enabled: false }));
    expect(provider).toBeUndefined();
  });

  it('returns DegradedSummarizationProvider when no key resolves', () => {
    const provider = createSummarizationProvider(createConfig({ summarization_enabled: true }));
    expect(provider).toBeInstanceOf(DegradedSummarizationProvider);
  });

  it('returns OpenAISummarizationProvider when summarization_model_env resolves', () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'key';
    const provider = createSummarizationProvider(createConfig({ summarization_enabled: true }));
    expect(provider).toBeInstanceOf(OpenAISummarizationProvider);
  });
});

describe('warnIfSummarizationDegraded', () => {
  afterEach(() => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
  });

  it('warns when summarization is enabled but no key resolved', () => {
    const provider = new DegradedSummarizationProvider();
    const logger = { warn: vi.fn() };
    warnIfSummarizationDegraded(provider, createConfig({ summarization_enabled: true }), logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'summarization_degraded_startup' }));
  });

  it('does not warn when summarization is deliberately disabled', () => {
    const logger = { warn: vi.fn() };
    warnIfSummarizationDegraded(undefined, createConfig({ summarization_enabled: false }), logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when the resolved provider is not degraded', () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'key';
    const provider = createSummarizationProvider(createConfig({ summarization_enabled: true }));
    const logger = { warn: vi.fn() };
    warnIfSummarizationDegraded(provider, createConfig({ summarization_enabled: true }), logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
