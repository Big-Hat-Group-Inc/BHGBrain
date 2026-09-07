import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureFoundryEmbeddingProvider } from './azure-foundry.js';
import { DegradedEmbeddingProvider, OpenAIEmbeddingProvider, createEmbeddingProvider, warnIfEmbeddingDegraded } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';

describe('OpenAIEmbeddingProvider', () => {
  function createConfig(): BrainConfig {
    return {
      data_dir: 'test-data',
      embedding: {
        provider: 'openai',
        model: 'test-model',
        api_key_env: 'OPENAI_API_KEY',
        dimensions: 3,
        request_timeout_ms: 30000,
        max_batch_inputs: 2048,
        retry: {
          max_attempts: 3,
          backoff_ms: 1000,
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
        scheduled_cleanup_enabled: true,
        pre_expiry_warning_days: 7,
        compaction_deleted_threshold: 0.1,
        audit_log_max_entries: 50000,
        revisions_per_memory_max: 20,
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
      // Cast rather than hand-maintaining every nested field this fixture
      // doesn't exercise: these embedding-provider tests only read
      // `config.embedding`/`config.data_dir`, and the full `BrainConfig`
      // shape has since grown with unrelated sections (retention scheduling,
      // security rate-limit buckets, etc.) added by other proposals. Matches
      // the same escape hatch `config/index.test.ts`'s own `makeConfig` uses.
    } as unknown as BrainConfig;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    delete process.env.AZURE_FOUNDRY_API_KEY;
  });

  function createAzureConfig(): BrainConfig {
    return {
      ...createConfig(),
      embedding: {
        ...createConfig().embedding,
        provider: 'azure-foundry',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        azure: {
          resource_name: 'test-resource',
          api_key_env: 'AZURE_FOUNDRY_API_KEY',
        },
      },
    };
  }

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

    const config = createConfig();
    // No retry noise: this test only cares about the terminal wrapping
    // behavior, not the retry loop (covered separately below).
    config.embedding.retry.max_attempts = 1;
    const provider = new OpenAIEmbeddingProvider(config);
    await expect(provider.embed('hello')).rejects.toThrow('Embedding provider unreachable: OpenAI request failed: network down');
  });

  it('includes HTTP status code in non-retryable embedding API failures', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));

    const provider = new OpenAIEmbeddingProvider(createConfig());
    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      message: 'OpenAI embeddings request rejected (HTTP 400)',
      retryable: false,
    });
  });

  // cut-embedding-and-qdrant-round-trips: OpenAI now shares the Azure
  // provider's timeout/retry/classification machinery (src/embedding/
  // request.ts) instead of a bare, unbounded `fetch`.
  it('aborts an OpenAI request at request_timeout_ms', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
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
    config.embedding.request_timeout_ms = 10;
    config.embedding.retry.max_attempts = 1;
    const provider = new OpenAIEmbeddingProvider(config);
    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      message: 'Embedding provider unreachable: OpenAI request timed out after 10ms',
      retryable: true,
    });
  });

  it('retries transient 5xx/429 failures up to retry.max_attempts then surfaces the classified error', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.retry.max_attempts = 3;
    config.embedding.retry.backoff_ms = 1;
    const provider = new OpenAIEmbeddingProvider(config);

    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      message: 'OpenAI embedding provider error 503',
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a transient failure that succeeds on retry resolves without exhausting attempts', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount <= 1) {
        return new Response('', { status: 502 });
      }
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.retry.max_attempts = 3;
    config.embedding.retry.backoff_ms = 1;
    const provider = new OpenAIEmbeddingProvider(config);

    await expect(provider.embed('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(callCount).toBe(2);
  });

  it('401 fails immediately without retry', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.retry.max_attempts = 3;
    const provider = new OpenAIEmbeddingProvider(config);

    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      message: 'OpenAI embeddings request rejected (HTTP 401)',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records at most one breaker failure per embedBatch even when retries are exhausted', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));

    const config = createConfig();
    config.embedding.retry.max_attempts = 3;
    config.embedding.retry.backoff_ms = 1;
    const provider = new OpenAIEmbeddingProvider(config, breaker);

    await expect(provider.embed('hello')).rejects.toThrow();
    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });

  it('healthCheck issues a single request with no retry/backoff on a retryable failure', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.retry.max_attempts = 3;
    config.embedding.retry.backoff_ms = 1;
    const provider = new OpenAIEmbeddingProvider(config);

    await expect(provider.healthCheck()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('creates the Azure provider when Azure credentials are present', () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const created = createEmbeddingProvider(createAzureConfig());
    expect(created).toBeInstanceOf(AzureFoundryEmbeddingProvider);
  });

  it('degrades the Azure provider only when startup credentials are missing', () => {
    const created = createEmbeddingProvider(createAzureConfig());
    expect(created).toBeInstanceOf(DegradedEmbeddingProvider);
  });

  it('rethrows invalid Azure config instead of degrading', () => {
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    const config = {
      ...createAzureConfig(),
      embedding: {
        ...createAzureConfig().embedding,
        azure: undefined,
      },
    };

    expect(() => createEmbeddingProvider(config)).toThrow('embedding.azure configuration is required for Azure provider');
  });

  it('warns at startup when the resolved provider is degraded', () => {
    const config = createConfig();
    const degraded = new DegradedEmbeddingProvider(config);
    const logger = { warn: vi.fn() };

    warnIfEmbeddingDegraded(degraded, config, logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'degraded_startup',
      provider: 'openai',
      reason: expect.stringContaining('credentials'),
    }));
  });

  it('does not warn at startup when the provider resolved normally', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const config = createConfig();
    const provider = new OpenAIEmbeddingProvider(config);
    const logger = { warn: vi.fn() };

    warnIfEmbeddingDegraded(provider, config, logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  // unify-llm-client-boundaries task 2.5: OpenAI embeddings now honor
  // max_batch_inputs (previously only the Azure provider chunked at all) and
  // reassemble results across chunks in input order.
  it('chunks embedBatch requests larger than max_batch_inputs and reassembles results in order', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string) as { input: string[] };
      return new Response(JSON.stringify({
        data: body.input.map((_text, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })),
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = createConfig();
    config.embedding.max_batch_inputs = 2;
    const provider = new OpenAIEmbeddingProvider(config);
    const results = await provider.embedBatch(['a', 'b', 'c', 'd', 'e']);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(5);
  });

  // task 2.5 / spec "Embedding gateway returns a short result array": a
  // response with fewer embeddings than requested inputs must fail the
  // whole batch rather than silently misassociating vectors.
  it('rejects a response with fewer embeddings than requested inputs', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 })));

    const provider = new OpenAIEmbeddingProvider(createConfig());
    await expect(provider.embedBatch(['a', 'b'])).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      retryable: false,
    });
  });

  it('rejects a response whose vector dimensions do not match the configured dimensions', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2] }], // config dimensions is 3
    }), { status: 200 })));

    const provider = new OpenAIEmbeddingProvider(createConfig());
    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      retryable: false,
    });
  });

  // task 2.4: the deadline (and, when a breaker is supplied, the breaker)
  // now covers body read/parse — a provider that returns 2xx headers and
  // then stalls mid-body must still abort at request_timeout_ms and record
  // a breaker failure, not a silent success.
  it('bounds a post-header stall through body read and trips the breaker as a failure', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    let bodySignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      bodySignal = init?.signal ?? undefined;
      // Headers resolve immediately; the body stream never delivers until
      // the abort signal fires, mirroring how an aborted real fetch's
      // in-flight body read rejects.
      return new Promise<Response>(resolve => {
        const stream = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              controller.error(err);
            });
          },
        });
        resolve(new Response(stream, { status: 200 }));
      });
    }));

    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;

    const config = createConfig();
    config.embedding.request_timeout_ms = 20;
    config.embedding.retry.max_attempts = 1;
    const provider = new OpenAIEmbeddingProvider(config, breaker);

    await expect(provider.embed('hello')).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE', retryable: true });
    expect(breaker.execute).toHaveBeenCalledTimes(1);
    expect(bodySignal?.aborted).toBe(true);
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
