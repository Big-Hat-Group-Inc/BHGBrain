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

  let embedding: EmbeddingProvider;
  let storage: StorageManager;

  beforeEach(() => {
    // Fresh per test: several tests reassign `embedding.embed` /
    // `storage.qdrant.searchSimilar` to simulate failures, and those
    // overrides must not leak into later tests.
    embedding = {
      model: 'test-model',
      dimensions: 2,
      embed: vi.fn(async () => [0.1, 0.2]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
      healthCheck: vi.fn(async () => true),
    };
    storage = {
      sqlite: {
        getMemoryByChecksum: vi.fn(() => null),
        getMemoryById: vi.fn(() => ({
          id: 'existing-id',
          summary: 'existing summary',
          type: 'semantic',
          content: 'existing content',
          created_at: '2026-01-01T00:00:00.000Z',
          importance: 0.5,
          tags: [],
        })),
        insertMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        fullTextSearch: vi.fn(() => []),
      },
      qdrant: {
        searchSimilar: vi.fn(async () => [{ id: 'existing-id', score: 0.99 }]),
      },
      updateMemory: vi.fn(),
      writeMemory: vi.fn(),
      writeMemoryWithoutVector: vi.fn(),
      deleteMemory: vi.fn(async () => true),
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

  it('emits a structured warning log when the degraded-write fallback is taken', async () => {
    embedding.embed = vi.fn(async () => { throw new Error('embedding unavailable'); });
    const logger = { warn: vi.fn() };
    const pipeline = new WritePipeline(config, storage, embedding, logger);

    await pipeline.process({
      content: 'fallback content',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'degraded_write',
      namespace: 'global',
      collection: 'general',
      error: 'embedding unavailable',
    }));
  });

  it('does not warn when the write succeeds without a degraded fallback', async () => {
    const logger = { warn: vi.fn() };
    const pipeline = new WritePipeline(config, storage, embedding, logger);

    await pipeline.process({
      content: 'brand new content',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('classifies UPDATE and merges when similarity is below NOOP but at/above the update threshold', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'existing-id', score: 0.95 }]);
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'a refinement of the existing memory',
      namespace: 'global',
      collection: 'general',
      tags: ['new-tag'],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('UPDATE');
    expect(result[0]!.merged_with_id).toBe('existing-id');
    expect(storage.updateMemory).toHaveBeenCalledTimes(1);
    expect(storage.writeMemory).not.toHaveBeenCalled();
    expect(storage.logAudit).toHaveBeenCalledWith('UPDATE', 'existing-id', 'global', undefined);
  });

  it('fails when UPDATE target is missing instead of silently duplicating as ADD', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'missing-id', score: 0.95 }]);
    storage.sqlite.getMemoryById = vi.fn(() => null);
    const pipeline = new WritePipeline(config, storage, embedding);

    await expect(
      pipeline.process({
        content: 'a refinement of a memory that has drifted out of sqlite',
        namespace: 'global',
        collection: 'general',
        tags: [],
        source: 'cli',
      }),
    ).rejects.toThrow('UPDATE target');

    expect(storage.writeMemory).not.toHaveBeenCalled();
    expect(storage.updateMemory).not.toHaveBeenCalled();
  });

  it('classifies DELETE and stores the correction when the candidate explicitly invalidates a similar memory', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'existing-id', score: 0.95 }]);
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'That is no longer true, the deployment now uses containers.',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('DELETE');
    expect(result[0]!.merged_with_id).toBe('existing-id');
    expect(storage.deleteMemory).toHaveBeenCalledWith('existing-id');
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
    expect(storage.logAudit).toHaveBeenCalledWith('DELETE', 'existing-id', 'global', undefined);
    expect(storage.logAudit).toHaveBeenCalledWith('ADD', result[0]!.id, 'global', undefined);
  });

  it('fails when DELETE target is missing instead of silently proceeding', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'missing-id', score: 0.95 }]);
    storage.sqlite.getMemoryById = vi.fn(() => null);
    const pipeline = new WritePipeline(config, storage, embedding);

    await expect(
      pipeline.process({
        content: 'This is no longer true and needs correcting.',
        namespace: 'global',
        collection: 'general',
        tags: [],
        source: 'cli',
      }),
    ).rejects.toThrow('DELETE target');

    expect(storage.deleteMemory).not.toHaveBeenCalled();
    expect(storage.writeMemory).not.toHaveBeenCalled();
  });

  it('uses full-text similarity to choose UPDATE over ADD in fallback mode', async () => {
    embedding.embed = vi.fn(async () => { throw new Error('embedding unavailable'); });
    storage.sqlite.fullTextSearch = vi.fn(() => [{ id: 'existing-id', rank: 5 }]);
    storage.sqlite.getMemoryById = vi.fn(() => ({
      id: 'existing-id',
      summary: 'existing summary',
      type: 'semantic',
      content: 'shared wording used for the fallback similarity test',
      created_at: '2026-01-01T00:00:00.000Z',
      importance: 0.5,
      tags: [],
    }));
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'shared wording used for the fallback similarity test',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('UPDATE');
    expect(result[0]!.merged_with_id).toBe('existing-id');
    expect(storage.updateMemory).toHaveBeenCalledTimes(1);
    expect(storage.writeMemoryWithoutVector).not.toHaveBeenCalled();
  });

  it('falls back to ADD when full-text similarity is below the update threshold', async () => {
    embedding.embed = vi.fn(async () => { throw new Error('embedding unavailable'); });
    storage.sqlite.fullTextSearch = vi.fn(() => [{ id: 'existing-id', rank: 1 }]);
    storage.sqlite.getMemoryById = vi.fn(() => ({
      id: 'existing-id',
      summary: 'existing summary',
      type: 'semantic',
      content: 'completely unrelated wording about something else entirely',
      created_at: '2026-01-01T00:00:00.000Z',
      importance: 0.5,
      tags: [],
    }));
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'brand new fallback content sharing nothing in common',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('ADD');
    expect(storage.writeMemoryWithoutVector).toHaveBeenCalledTimes(1);
    expect(storage.updateMemory).not.toHaveBeenCalled();
  });

  it('does not silently record a novel write when the similarity check is unavailable', async () => {
    // searchSimilar failing (transport/auth/removed-method) must not be
    // treated the same as "no near duplicates" - the write should fail
    // rather than proceeding as an ADD.
    storage.qdrant.searchSimilar = vi.fn(async () => {
      throw new Error('vector store unavailable');
    });
    const pipeline = new WritePipeline(config, storage, embedding);

    await expect(
      pipeline.process({
        content: 'some content',
        namespace: 'global',
        collection: 'general',
        tags: [],
        source: 'cli',
      }),
    ).rejects.toThrow('vector store unavailable');

    expect(storage.writeMemory).not.toHaveBeenCalled();
    expect(storage.writeMemoryWithoutVector).not.toHaveBeenCalled();
    expect(storage.updateMemory).not.toHaveBeenCalled();
  });
});
