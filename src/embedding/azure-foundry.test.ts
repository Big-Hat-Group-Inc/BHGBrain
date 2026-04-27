import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureFoundryEmbeddingProvider } from './azure-foundry.js';
import { getEmbeddingBreakerKey } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';

describe('AzureFoundryEmbeddingProvider', () => {
  function createConfig(): BrainConfig {
    return {
      data_dir: 'test-data',
      embedding: {
        provider: 'azure-foundry',
        model: 'text-embedding-3-small',
        api_key_env: 'OPENAI_API_KEY',
        dimensions: 1536,
        request_timeout_ms: 30000,
        max_batch_inputs: 2048,
        retry: {
          max_attempts: 3,
          backoff_ms: 1000,
        },
        azure: {
          resource_name: 'test-resource',
          api_key_env: 'AZURE_FOUNDRY_API_KEY',
        },
      },
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
    delete process.env.AZURE_FOUNDRY_API_KEY;
  });

  it('constructs correct base URL', () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const config = createConfig();
    const provider = new AzureFoundryEmbeddingProvider(config);
    expect(provider).toBeInstanceOf(AzureFoundryEmbeddingProvider);
    // The base URL is private, but we can verify by mocking fetch and checking request URL
    // We'll test through request behavior in other tests.
  });

  it('reads api key at construction time', () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const config = createConfig();
    const provider = new AzureFoundryEmbeddingProvider(config);
    expect(provider).toBeDefined();
    // If key missing, constructor should throw
    delete process.env.AZURE_FOUNDRY_API_KEY;
    expect(() => new AzureFoundryEmbeddingProvider(config)).toThrow('Missing environment variable: AZURE_FOUNDRY_API_KEY');
  });

  it('sends api-key header', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AzureFoundryEmbeddingProvider(createConfig());
    await provider.embed('hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://test-resource.openai.azure.com/openai/v1/embeddings');
    expect(options.headers).toEqual({
      'api-key': 'test-key',
      'Content-Type': 'application/json',
    });
  });

  it('includes dimensions for v3 models', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.model = 'text-embedding-3-small';
    config.embedding.dimensions = 512;
    const provider = new AzureFoundryEmbeddingProvider(config);
    await provider.embed('hello');

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.dimensions).toBe(512);
  });

  it('omits dimensions for ada-002', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.model = 'text-embedding-ada-002';
    const provider = new AzureFoundryEmbeddingProvider(config);
    await provider.embed('hello');

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.dimensions).toBeUndefined();
  });

  it('chunks batches larger than max_batch_inputs', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.max_batch_inputs = 2;
    const provider = new AzureFoundryEmbeddingProvider(config);
    const texts = ['a', 'b', 'c', 'd', 'e']; // 5 texts, chunk size 2 => 3 requests
    await provider.embedBatch(texts);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('aborts on timeout', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        const abortError = new Error('Request timed out');
        abortError.name = 'AbortError';
        reject(abortError);
      });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.request_timeout_ms = 10; // very short timeout
    config.embedding.retry.max_attempts = 1;
    const provider = new AzureFoundryEmbeddingProvider(config);
    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      message: 'Azure embedding provider unreachable: Request timed out',
      retryable: true,
    });
  });

  it('retries retryable failures only', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response('', { status: 502 }); // retryable 5xx
      }
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.retry.max_attempts = 3;
    config.embedding.retry.backoff_ms = 1;
    const provider = new AzureFoundryEmbeddingProvider(config);
    await provider.embed('hello');

    expect(callCount).toBe(3); // 2 failures + 1 success
  });

  it('does not retry non-retryable failures', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    const provider = new AzureFoundryEmbeddingProvider(config);
    await expect(provider.embed('hello')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });

  it('maps 429 to rateLimited error', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.retry.max_attempts = 1;
    const provider = new AzureFoundryEmbeddingProvider(config);
    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Azure embeddings rate limited',
      retryable: true,
    });
  });

  it('preserves non-retryable client errors without wrapping them as unreachable', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.retry.max_attempts = 3;
    const provider = new AzureFoundryEmbeddingProvider(config);
    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      message: 'Azure embeddings request rejected (HTTP 400)',
      retryable: false,
    });
  });

  it('wraps calls with circuit breaker', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 })));

    const provider = new AzureFoundryEmbeddingProvider(createConfig(), breaker);
    await expect(provider.embed('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });

  it('healthCheck bypasses circuit breaker', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 })));

    const provider = new AzureFoundryEmbeddingProvider(createConfig(), breaker);
    await expect(provider.healthCheck()).resolves.toBe(true);
    expect(breaker.execute).not.toHaveBeenCalled();
  });

  it('healthCheck returns false on auth failure', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const provider = new AzureFoundryEmbeddingProvider(createConfig());
    await expect(provider.healthCheck()).resolves.toBe(false);
  });

  it('records embedding_embed_batch_ms in finally', async () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const metrics = {
      recordHistogram: vi.fn(),
    } as unknown as MetricsCollector;

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 })));

    const provider = new AzureFoundryEmbeddingProvider(createConfig(), undefined, metrics);
    await provider.embed('hello');
    expect(metrics.recordHistogram).toHaveBeenCalledWith('embedding_embed_batch_ms', expect.any(Number));
  });

  it('invalid azure config fails startup', () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const config = createConfig();
    config.embedding.azure = undefined;
    expect(() => new AzureFoundryEmbeddingProvider(config)).toThrow('embedding.azure configuration is required for Azure provider');
  });

  it('breaker key helper returns provider-aware names', () => {
    expect(getEmbeddingBreakerKey('openai')).toBe('openai_embedding');
    expect(getEmbeddingBreakerKey('azure-foundry')).toBe('azure_foundry_embedding');
  });
});
