import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LlmExtractionProvider,
  NoopExtractionProvider,
  createExtractionProvider,
  warnIfExtractionDegraded,
} from './extraction.js';
import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';
import type { MetricsCollector } from '../health/metrics.js';

function createConfig(overrides: Partial<BrainConfig['pipeline']> = {}): BrainConfig {
  return {
    pipeline: {
      extraction_enabled: true,
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
      extraction_min_chars: 120,
      extraction_max_candidates: 3,
      extraction_timeout_ms: 4000,
      fallback_to_threshold_dedup: true,
      contradiction_detection: { enabled: false, timeout_ms: 5000 },
      ...overrides,
    },
  } as unknown as BrainConfig;
}

function chatResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function withCandidates(candidates: unknown): unknown {
  return {
    choices: [{ message: { content: JSON.stringify({ candidates }) } }],
  };
}

describe('LlmExtractionProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns validated candidates on a well-formed response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withCandidates([
      { content: 'Alice owns the infra repo', type: 'semantic', importance: 0.7 },
      { content: 'Deploys go through GitHub Actions' },
    ]))));

    const provider = new LlmExtractionProvider(createConfig(), 'test-key');
    const result = await provider.extractCandidates('some multi-fact content');

    expect(result).toEqual([
      { content: 'Alice owns the infra repo', type: 'semantic', importance: 0.7 },
      { content: 'Deploys go through GitHub Actions' },
    ]);
  });

  it('returns null on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));

    const provider = new LlmExtractionProvider(createConfig(), 'test-key');
    await expect(provider.extractCandidates('content')).resolves.toBeNull();
  });

  it('returns null when the chat completion body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse({
      choices: [{ message: { content: 'not-json-at-all' } }],
    })));

    const provider = new LlmExtractionProvider(createConfig(), 'test-key');
    await expect(provider.extractCandidates('content')).resolves.toBeNull();
  });

  it('returns null on a schema-invalid response (missing content)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withCandidates([
      { type: 'semantic' },
    ]))));

    const provider = new LlmExtractionProvider(createConfig(), 'test-key');
    await expect(provider.extractCandidates('content')).resolves.toBeNull();
  });

  it('returns null on an empty candidates array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withCandidates([]))));

    const provider = new LlmExtractionProvider(createConfig(), 'test-key');
    await expect(provider.extractCandidates('content')).resolves.toBeNull();
  });

  it('returns null when every candidate is empty after trim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withCandidates([
      { content: '   ' },
    ]))));

    const provider = new LlmExtractionProvider(createConfig(), 'test-key');
    await expect(provider.extractCandidates('content')).resolves.toBeNull();
  });

  it('returns null on a fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const provider = new LlmExtractionProvider(createConfig(), 'test-key');
    await expect(provider.extractCandidates('content')).resolves.toBeNull();
  });

  it('returns null on a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal;
      signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })));

    const provider = new LlmExtractionProvider(createConfig({ extraction_timeout_ms: 5 }), 'test-key');
    await expect(provider.extractCandidates('content')).resolves.toBeNull();
  });

  it('truncates candidates beyond extraction_max_candidates and logs/counts it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withCandidates([
      { content: 'fact one' },
      { content: 'fact two' },
      { content: 'fact three' },
      { content: 'fact four' },
    ]))));

    const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn() } as unknown as MetricsCollector;
    const logger = { warn: vi.fn() };
    const provider = new LlmExtractionProvider(createConfig({ extraction_max_candidates: 3 }), 'test-key', undefined, metrics, logger);

    const result = await provider.extractCandidates('content');

    expect(result).toHaveLength(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'extraction_candidates_truncated' }));
    expect(metrics.incCounter).toHaveBeenCalledWith('extraction_candidates_truncated_total');
  });

  it('invokes the circuit breaker for the chat-completions call', async () => {
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withCandidates([{ content: 'one fact' }]))));

    const provider = new LlmExtractionProvider(createConfig(), 'test-key', breaker);
    await provider.extractCandidates('content');

    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });
});

describe('createExtractionProvider', () => {
  afterEach(() => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('returns NoopExtractionProvider when extraction is disabled', () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'key';
    const provider = createExtractionProvider(createConfig({ extraction_enabled: false }));
    expect(provider).toBeInstanceOf(NoopExtractionProvider);
  });

  it('returns NoopExtractionProvider when no key resolves', () => {
    const provider = createExtractionProvider(createConfig({ extraction_enabled: true }));
    expect(provider).toBeInstanceOf(NoopExtractionProvider);
  });

  it('returns LlmExtractionProvider when extraction_model_env resolves', () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'key';
    const provider = createExtractionProvider(createConfig({ extraction_enabled: true }));
    expect(provider).toBeInstanceOf(LlmExtractionProvider);
  });

  it('falls back to OPENAI_API_KEY when extraction_model_env is unset', () => {
    process.env.OPENAI_API_KEY = 'key';
    const provider = createExtractionProvider(createConfig({ extraction_enabled: true }));
    expect(provider).toBeInstanceOf(LlmExtractionProvider);
  });
});

describe('warnIfExtractionDegraded', () => {
  afterEach(() => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('warns when extraction is enabled but no key resolved', () => {
    const provider = new NoopExtractionProvider();
    const logger = { warn: vi.fn() };
    warnIfExtractionDegraded(provider, createConfig({ extraction_enabled: true }), logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'extraction_degraded_startup' }));
  });

  it('does not warn when extraction is deliberately disabled', () => {
    const provider = new NoopExtractionProvider();
    const logger = { warn: vi.fn() };
    warnIfExtractionDegraded(provider, createConfig({ extraction_enabled: false }), logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when the resolved provider is not degraded', () => {
    process.env.OPENAI_API_KEY = 'key';
    const provider = createExtractionProvider(createConfig({ extraction_enabled: true }));
    const logger = { warn: vi.fn() };
    warnIfExtractionDegraded(provider, createConfig({ extraction_enabled: true }), logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
