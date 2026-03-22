import { afterEach, describe, expect, it, vi } from 'vitest';
import { DegradedEmbeddingProvider, OpenAIEmbeddingProvider, createEmbeddingProvider } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';

describe('OpenAIEmbeddingProvider', () => {
  function createConfig(): BrainConfig {
    return {
      data_dir: 'test-data',
      embedding: { provider: 'openai', model: 'test-model', api_key_env: 'OPENAI_API_KEY', dimensions: 3 },
      qdrant: { mode: 'embedded', embedded_path: './qdrant', external_url: null, api_key_env: null },
      transport: {
        http: { enabled: true, host: '127.0.0.1', port: 3721, bearer_token_env: 'BHGBRAIN_TOKEN' },
        stdio: { enabled: true },
      },
      defaults: {
        namespace: 'global',
        collection: 'general',
        recall_limit: 5,
        min_score: 0.6,
        auto_inject_limit: 10,
        max_response_chars: 50000,
      },
      retention: {
        decay_after_days: 180,
        max_db_size_gb: 2,
        max_memories: 500000,
        warn_at_percent: 80,
        tier_ttl: { T0: null, T1: 365, T2: 90, T3: 30 },
        tier_budgets: { T0: null, T1: 100000, T2: 200000, T3: 200000 },
        auto_promote_access_threshold: 5,
        sliding_window_enabled: true,
        archive_before_delete: true,
        cleanup_schedule: '0 2 * * *',
        pre_expiry_warning_days: 7,
        compaction_deleted_threshold: 0.1,
      },
      deduplication: { enabled: true, similarity_threshold: 0.92 },
      resilience: {
        circuit_breaker: {
          failure_threshold: 1,
          open_window_ms: 30000,
          half_open_probe_count: 1,
        },
      },
      search: { hybrid_weights: { semantic: 0.7, fulltext: 0.3 } },
      security: {
        require_loopback_http: true,
        allow_unauthenticated_http: false,
        log_redaction: true,
        rate_limit_rpm: 100,
        max_request_size_bytes: 1048576,
      },
      auto_inject: { max_chars: 30000, max_tokens: null },
      observability: { metrics_enabled: false, structured_logging: true, log_level: 'info' },
      pipeline: {
        extraction_enabled: true,
        extraction_model: 'gpt-4o-mini',
        extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
        fallback_to_threshold_dedup: true,
      },
      auto_summarize: true,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it('invokes the breaker for embed calls', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 })));

    const provider = new OpenAIEmbeddingProvider(createConfig(), breaker);
    await expect(provider.embed('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves response ordering by index in embedBatch', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [2, 2, 2] },
        { index: 0, embedding: [1, 1, 1] },
      ],
    }), { status: 200 })));

    const provider = new OpenAIEmbeddingProvider(createConfig());
    await expect(provider.embedBatch(['a', 'b'])).resolves.toEqual([[1, 1, 1], [2, 2, 2]]);
  });

  it('wraps network failures as embeddingUnavailable errors', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const provider = new OpenAIEmbeddingProvider(createConfig());
    await expect(provider.embed('hello')).rejects.toThrow('Embedding provider unreachable: network down');
  });

  it('includes HTTP status code in embedding API failures', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));

    const provider = new OpenAIEmbeddingProvider(createConfig());
    await expect(provider.embed('hello')).rejects.toThrow('Embedding API error 429');
  });

  it('bypasses the breaker during health checks', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 })));

    const provider = new OpenAIEmbeddingProvider(createConfig(), breaker);
    await expect(provider.healthCheck()).resolves.toBe(true);
    expect(breaker.execute).not.toHaveBeenCalled();
  });

  it('returns false from healthCheck when the probe fails', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 500 })));

    const provider = new OpenAIEmbeddingProvider(createConfig());
    await expect(provider.healthCheck()).resolves.toBe(false);
  });

  it('exposes degraded provider behavior and factory fallback', async () => {
    const config = createConfig();
    const degraded = new DegradedEmbeddingProvider(config);

    await expect(degraded.embed()).rejects.toThrow('missing API credentials');
    await expect(degraded.embedBatch()).rejects.toThrow('missing API credentials');
    await expect(degraded.healthCheck()).resolves.toBe(false);

    const created = createEmbeddingProvider(config);
    expect(created).toBeInstanceOf(DegradedEmbeddingProvider);
  });

  it('throws when createEmbeddingProvider receives an unknown provider', () => {
    const config = {
      ...createConfig(),
      embedding: {
        ...createConfig().embedding,
        provider: 'unknown',
      },
    } as unknown as BrainConfig;

    expect(() => createEmbeddingProvider(config)).toThrow('Unknown embedding provider: unknown');
  });
});
