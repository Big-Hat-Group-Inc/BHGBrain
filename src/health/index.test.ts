import { describe, it, expect, vi } from 'vitest';
import { HealthService } from './index.js';
import { DegradedEmbeddingProvider } from '../embedding/index.js';
import { CircuitBreaker } from '../resilience/index.js';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';

describe('HealthService', () => {
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

  function createStorage(): StorageManager {
    return {
      sqlite: {
        healthCheck: vi.fn(() => true),
        countMemories: vi.fn(() => 42),
        getDbSizeBytes: vi.fn(() => 1024),
        countByTier: vi.fn(() => ({ T0: 0, T1: 0, T2: 0, T3: 0 })),
        countExpiringMemories: vi.fn(() => 0),
        countArchivedMemories: vi.fn(() => 0),
        countUnsyncedVectors: vi.fn(() => 0),
        getLifecycleOperation: vi.fn(() => null),
      },
      qdrant: {
        healthCheck: vi.fn(async () => true),
      },
    } as unknown as StorageManager;
  }

  function createEmbedding(embeddingOk = true): EmbeddingProvider {
    return {
      model: 'test',
      dimensions: 3,
      embed: vi.fn(async () => [1, 2, 3]),
      embedBatch: vi.fn(async () => [[1, 2, 3]]),
      healthCheck: vi.fn(async () => embeddingOk),
    };
  }

  function createAzureConfig(): BrainConfig {
    return {
      ...createConfig(),
      embedding: {
        ...createConfig().embedding,
        provider: 'azure-foundry',
        azure: {
          resource_name: 'test-resource',
          api_key_env: 'AZURE_FOUNDRY_API_KEY',
        },
      },
    };
  }

  it('reports degraded when embedding provider is in degraded mode', async () => {
    const storage = createStorage();
    const embedding = new DegradedEmbeddingProvider(createConfig());
    const health = new HealthService(storage, embedding, createConfig());
    const result = await health.check();
    expect(result.status).toBe('degraded');
    expect(result.components.embedding.status).toBe('degraded');
  });

  it('reports degraded when any breaker is open', async () => {
    const storage = createStorage();
    const embedding = createEmbedding(true);
    const config = createConfig();
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openWindowMs: 30000, halfOpenProbeCount: 1 },
      () => 0,
    );

    await expect(breaker.execute(async () => {
      throw new Error('trip');
    })).rejects.toThrow('trip');

    const health = new HealthService(storage, embedding, config, {
      openai_embedding: breaker,
    });
    const result = await health.check();

    expect(result.status).toBe('degraded');
    expect(result.circuitBreakers).toEqual({ openai_embedding: 'open' });
  });

  it('reports the Azure embedding breaker with the provider-aware key', async () => {
    const storage = createStorage();
    const embedding = createEmbedding(true);
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openWindowMs: 30000, halfOpenProbeCount: 1 },
      () => 0,
    );

    await expect(breaker.execute(async () => {
      throw new Error('trip');
    })).rejects.toThrow('trip');

    const health = new HealthService(storage, embedding, createAzureConfig(), {
      azure_foundry_embedding: breaker,
    });
    const result = await health.check();

    expect(result.status).toBe('degraded');
    expect(result.circuitBreakers).toEqual({ azure_foundry_embedding: 'open' });
  });

  it('reports healthy when all components are up', async () => {
    const storage = createStorage();
    const embedding = createEmbedding(true);
    const health = new HealthService(storage, embedding, createConfig());
    const result = await health.check();
    expect(result.status).toBe('healthy');
    expect(result.components.vector_reconciliation).toEqual({
      status: 'healthy',
      state: 'reconciled',
      unsynced_vectors: 0,
    });
  });

  it('caches embedding health check result', async () => {
    const storage = createStorage();
    const embedding = createEmbedding(true);
    const health = new HealthService(storage, embedding, createConfig());

    await health.check();
    await health.check();
    await health.check();

    expect(embedding.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('returns memory count and db size', async () => {
    const storage = createStorage();
    const embedding = createEmbedding(true);
    const health = new HealthService(storage, embedding, createConfig());
    const result = await health.check();
    expect(result.memory_count).toBe(42);
    expect(result.db_size_bytes).toBe(1024);
  });

  it('reports degraded when qdrant is unavailable but sqlite is healthy', async () => {
    const storage = createStorage();
    storage.qdrant.healthCheck = vi.fn(async () => false);

    const health = new HealthService(storage, createEmbedding(true), createConfig());
    const result = await health.check();

    expect(result.status).toBe('degraded');
    expect(result.components.qdrant.status).toBe('unhealthy');
  });

  it('reports unhealthy when sqlite is unavailable', async () => {
    const storage = createStorage();
    storage.sqlite.healthCheck = vi.fn(() => false);

    const health = new HealthService(storage, createEmbedding(true), createConfig());
    const result = await health.check();

    expect(result.status).toBe('unhealthy');
    expect(result.components.sqlite.status).toBe('unhealthy');
  });

  it('reports degraded when vectors still need reconciliation after restore', async () => {
    const storage = createStorage();
    storage.sqlite.countUnsyncedVectors = vi.fn(() => 3);

    const health = new HealthService(storage, createEmbedding(true), createConfig());
    const result = await health.check();

    expect(result.status).toBe('degraded');
    expect(result.components.vector_reconciliation).toEqual({
      status: 'degraded',
      state: 'pending',
      unsynced_vectors: 3,
      message: 'SQLite metadata is active, but vector reconciliation is still required.',
    });
  });

  it('reports reconciling while restore lifecycle work is active', async () => {
    const storage = createStorage();
    storage.sqlite.getLifecycleOperation = vi.fn(() => 'restore');
    storage.sqlite.countUnsyncedVectors = vi.fn(() => 2);

    const health = new HealthService(storage, createEmbedding(true), createConfig());
    const result = await health.check();

    expect(result.status).toBe('degraded');
    expect(result.components.vector_reconciliation).toEqual({
      status: 'degraded',
      state: 'reconciling',
      unsynced_vectors: 2,
      message: 'Restore is active and vector reconciliation is in progress.',
    });
  });
});
