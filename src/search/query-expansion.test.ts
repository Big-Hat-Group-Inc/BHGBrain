import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  keywordStrippedVariant,
  buildVariants,
  LLMQueryExpansionProvider,
  warnIfQueryExpansionDegraded,
} from './query-expansion.js';
import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';

function createConfig(overrides: Partial<BrainConfig['pipeline']> = {}): BrainConfig {
  return {
    pipeline: {
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
      ...overrides,
    },
    search: {
      query_expansion: {
        llm_paraphrase: { enabled: false, mode: 'paraphrase', variant_count: 2, timeout_ms: 3000 },
      },
    },
  } as unknown as BrainConfig;
}

function chatResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function withVariants(variants: unknown): unknown {
  return { choices: [{ message: { content: JSON.stringify({ variants }) } }] };
}

describe('keywordStrippedVariant', () => {
  it('strips stopwords from a conversational query', () => {
    expect(keywordStrippedVariant('how do we deploy')).toBe('deploy');
  });

  it('returns null for an all-stopword query', () => {
    expect(keywordStrippedVariant('is it')).toBeNull();
  });

  it('returns null when stripping leaves the query unchanged (all-content-word)', () => {
    expect(keywordStrippedVariant('deploy production')).toBeNull();
  });

  it('returns null for empty/whitespace-only input', () => {
    expect(keywordStrippedVariant('   ')).toBeNull();
  });
});

describe('buildVariants', () => {
  const baseConfig: BrainConfig['search']['query_expansion'] = {
    enabled: true,
    max_variants: 2,
    keyword_stripped: true,
    llm_paraphrase: { enabled: false, mode: 'paraphrase', variant_count: 2, timeout_ms: 3000 },
  };

  it('appends the keyword-stripped variant when it differs from the original', () => {
    expect(buildVariants('how do we deploy', baseConfig)).toEqual(['how do we deploy', 'deploy']);
  });

  it('dedups a paraphrase identical to the original case-insensitively', () => {
    const variants = buildVariants('deploy', baseConfig, ['Deploy']);
    expect(variants).toEqual(['deploy']);
  });

  it('dedups a paraphrase identical to the keyword variant', () => {
    const variants = buildVariants('how do we deploy', baseConfig, ['Deploy']);
    expect(variants).toEqual(['how do we deploy', 'deploy']);
  });

  it('truncates to max_variants', () => {
    const config = { ...baseConfig, max_variants: 1 };
    expect(buildVariants('how do we deploy', config)).toEqual(['how do we deploy']);
  });

  it('yields only the original when keyword_stripped is disabled', () => {
    const config = { ...baseConfig, keyword_stripped: false };
    expect(buildVariants('how do we deploy', config)).toEqual(['how do we deploy']);
  });

  it('includes LLM variants up to the cap', () => {
    const config = { ...baseConfig, max_variants: 5 };
    const variants = buildVariants('how do we deploy', config, ['deployment steps', 'ship to prod']);
    expect(variants).toEqual(['how do we deploy', 'deploy', 'deployment steps', 'ship to prod']);
  });
});

describe('LLMQueryExpansionProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is unconfigured when no key resolves', () => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const provider = new LLMQueryExpansionProvider(createConfig());
    expect(provider.configured).toBe(false);
  });

  it('is configured from the extraction_model_env variable', () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    delete process.env.OPENAI_API_KEY;
    const provider = new LLMQueryExpansionProvider(createConfig());
    expect(provider.configured).toBe(true);
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
  });

  it('falls back to OPENAI_API_KEY when extraction_model_env is unset', () => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    process.env.OPENAI_API_KEY = 'fallback-key';
    const provider = new LLMQueryExpansionProvider(createConfig());
    expect(provider.configured).toBe(true);
    delete process.env.OPENAI_API_KEY;
  });

  it('returns [] without a network call when unconfigured', async () => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new LLMQueryExpansionProvider(createConfig());
    const result = await provider.generateVariants('how do we deploy', 'paraphrase', 2, 3000);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the expected paraphrase strings on success', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withVariants(['a', 'b']))));
    const provider = new LLMQueryExpansionProvider(createConfig());
    const result = await provider.generateVariants('how do we deploy', 'paraphrase', 2, 3000);
    expect(result).toEqual(['a', 'b']);
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
  });

  it('returns [] on a non-2xx response', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse({ error: 'nope' }, 500)));
    const provider = new LLMQueryExpansionProvider(createConfig());
    const result = await provider.generateVariants('q', 'paraphrase', 2, 3000);
    expect(result).toEqual([]);
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
  });

  it('returns [] on timeout, aborting at timeout_ms', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal;
      signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })));
    const provider = new LLMQueryExpansionProvider(createConfig());
    const result = await provider.generateVariants('q', 'paraphrase', 2, 5);
    expect(result).toEqual([]);
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
  });

  it('returns [] on malformed JSON without throwing', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    const provider = new LLMQueryExpansionProvider(createConfig());
    await expect(provider.generateVariants('q', 'paraphrase', 2, 3000)).resolves.toEqual([]);
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
  });

  it('increments the degraded counter and logs on failure', async () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse({ error: 'nope' }, 500)));
    const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn() } as unknown as MetricsCollector;
    const logger = { warn: vi.fn() };
    const provider = new LLMQueryExpansionProvider(createConfig(), undefined, metrics, logger);
    await provider.generateVariants('q', 'paraphrase', 2, 3000);
    expect(metrics.incCounter).toHaveBeenCalledWith('search_query_expansion_llm_degraded');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'query_expansion_llm_degraded' }));
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
  });
});

describe('warnIfQueryExpansionDegraded', () => {
  it('warns when enabled but unconfigured', () => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const config = createConfig();
    config.search.query_expansion.llm_paraphrase.enabled = true;
    const provider = new LLMQueryExpansionProvider(config);
    const logger = { warn: vi.fn() };
    warnIfQueryExpansionDegraded(provider, config, logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'query_expansion_degraded_startup' }));
  });

  it('does not warn when disabled', () => {
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const config = createConfig();
    const provider = new LLMQueryExpansionProvider(config);
    const logger = { warn: vi.fn() };
    warnIfQueryExpansionDegraded(provider, config, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when enabled and configured', () => {
    process.env.BHGBRAIN_EXTRACTION_API_KEY = 'test-key';
    const config = createConfig();
    config.search.query_expansion.llm_paraphrase.enabled = true;
    const provider = new LLMQueryExpansionProvider(config);
    const logger = { warn: vi.fn() };
    warnIfQueryExpansionDegraded(provider, config, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    delete process.env.BHGBRAIN_EXTRACTION_API_KEY;
  });
});
