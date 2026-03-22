import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WritePipeline } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { StorageManager } from '../storage/index.js';

describe('WritePipeline NOOP handling', () => {
  const config = {
    deduplication: { similarity_threshold: 0.92 },
    pipeline: { extraction_enabled: true, fallback_to_threshold_dedup: true },
  } as unknown as BrainConfig;

  const embedding: EmbeddingProvider = {
    model: 'test-model',
    dimensions: 2,
    embed: vi.fn(async () => [0.1, 0.2]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    healthCheck: vi.fn(async () => true),
  };

  let storage: StorageManager;

  beforeEach(() => {
    storage = {
      sqlite: {
        getMemoryByChecksum: vi.fn(() => null),
        getMemoryById: vi.fn(() => ({
          id: 'existing-id',
          summary: 'existing summary',
          type: 'semantic',
          created_at: '2026-01-01T00:00:00.000Z',
          importance: 0.5,
          tags: [],
        })),
        insertMemory: vi.fn(),
        flushIfDirty: vi.fn(),
      },
      qdrant: {
        searchSimilar: vi.fn(async () => [{ id: 'existing-id', score: 0.99 }]),
      },
      updateMemory: vi.fn(),
      writeMemory: vi.fn(),
      writeMemoryWithoutVector: vi.fn(),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
  });

  it('returns NOOP without writes when classification is NOOP', async () => {
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'same meaning content',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.operation).toBe('NOOP');
    expect(result[0]!.id).toBe('existing-id');
    expect(storage.writeMemory).not.toHaveBeenCalled();
    expect(storage.updateMemory).not.toHaveBeenCalled();
    expect(storage.logAudit).not.toHaveBeenCalled();
  });

  it('fails when NOOP target is missing', async () => {
    storage.sqlite.getMemoryById = vi.fn(() => null);
    const pipeline = new WritePipeline(config, storage, embedding);

    await expect(
      pipeline.process({
        content: 'same meaning content',
        namespace: 'global',
        collection: 'general',
        tags: [],
        source: 'cli',
      }),
    ).rejects.toThrow('NOOP target');

    expect(storage.writeMemory).not.toHaveBeenCalled();
    expect(storage.updateMemory).not.toHaveBeenCalled();
  });

  it('uses metadata-preserving degraded writes when embedding is unavailable', async () => {
    embedding.embed = vi.fn(async () => { throw new Error('embedding unavailable'); });
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'fallback content',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('ADD');
    expect(storage.writeMemoryWithoutVector).toHaveBeenCalledTimes(1);
    expect(storage.writeMemory).not.toHaveBeenCalled();
  });
});
