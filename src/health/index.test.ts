import { describe, it, expect, vi } from 'vitest';
import { HealthService } from './index.js';
import { DegradedEmbeddingProvider } from '../embedding/index.js';

describe('HealthService', () => {
  function createMocks(embeddingOk = true, degraded = false) {
    const storage = {
      sqlite: {
        healthCheck: vi.fn(() => true),
        countMemories: vi.fn(() => 42),
        getDbSizeBytes: vi.fn(() => 1024),
      },
      qdrant: {
        healthCheck: vi.fn(async () => true),
      },
    } as any;

    let embedding: any;
    if (degraded) {
      embedding = {
        model: 'test',
        dimensions: 3,
        degraded: true,
        embed: vi.fn(async () => { throw new Error('unavailable'); }),
        embedBatch: vi.fn(async () => { throw new Error('unavailable'); }),
        healthCheck: vi.fn(async () => false),
      };
    } else {
      embedding = {
        model: 'test',
        dimensions: 3,
        embed: vi.fn(async () => [1, 2, 3]),
        embedBatch: vi.fn(async () => [[1, 2, 3]]),
        healthCheck: vi.fn(async () => embeddingOk),
      };
    }

    return { storage, embedding };
  }

  it('reports degraded when embedding provider is in degraded mode', async () => {
    const { storage, embedding } = createMocks(false, true);
    const health = new HealthService(storage, embedding);
    const result = await health.check();
    expect(result.status).toBe('degraded');
    expect(result.components.embedding.status).toBe('degraded');
    // Should NOT call healthCheck API
    expect(embedding.healthCheck).not.toHaveBeenCalled();
  });

  it('reports healthy when all components are up', async () => {
    const { storage, embedding } = createMocks(true);
    const health = new HealthService(storage, embedding);
    const result = await health.check();
    expect(result.status).toBe('healthy');
  });

  it('caches embedding health check result', async () => {
    const { storage, embedding } = createMocks(true);
    const health = new HealthService(storage, embedding);

    await health.check();
    await health.check();
    await health.check();

    // Only one real healthCheck call despite 3 probes
    expect(embedding.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('returns memory count and db size', async () => {
    const { storage, embedding } = createMocks(true);
    const health = new HealthService(storage, embedding);
    const result = await health.check();
    expect(result.memory_count).toBe(42);
    expect(result.db_size_bytes).toBe(1024);
  });
});
