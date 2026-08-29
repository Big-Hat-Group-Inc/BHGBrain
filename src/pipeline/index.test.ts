import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WritePipeline } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { StorageManager } from '../storage/index.js';
import type { ExtractionProvider } from './extraction.js';
import { checkEntailment } from './entailment.js';
import type { SummarizationProvider } from '../summarization/index.js';

vi.mock('./entailment.js', () => ({
  checkEntailment: vi.fn(),
}));

describe('WritePipeline NOOP handling', () => {
  const config = {
    deduplication: { similarity_threshold: 0.92 },
    pipeline: {
      extraction_enabled: true,
      fallback_to_threshold_dedup: true,
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
      // contradiction_detection defaults to disabled — every test in this
      // describe block confirms zero behavior change while it's off (task
      // 4.6); the dedicated "WritePipeline contradiction detection" block
      // below opts it in per test.
      contradiction_detection: { enabled: false, timeout_ms: 5000 },
    },
  } as unknown as BrainConfig;

  let embedding: EmbeddingProvider;
  let storage: StorageManager;

  beforeEach(() => {
    vi.mocked(checkEntailment).mockReset();
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
    // contradiction_detection.enabled is false (the default) in this
    // describe block's shared config — the entailment check must never run.
    expect(checkEntailment).not.toHaveBeenCalled();
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

// add-memory-distillation, task 4.6 ("a cluster that re-forms after a prior
// distillation UPDATEs rather than duplicates the T1 memory"): confirms
// DistillationService's writes go through the exact same classifyOperation
// path every other write does (no special-casing), and that derived_from
// specifically accumulates via union on UPDATE rather than being clobbered
// or ignored.
describe('WritePipeline distillation derived_from (add-memory-distillation)', () => {
  const config = {
    deduplication: { similarity_threshold: 0.92 },
    pipeline: {
      extraction_enabled: false,
      fallback_to_threshold_dedup: true,
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
      contradiction_detection: { enabled: false, timeout_ms: 5000 },
    },
  } as unknown as BrainConfig;

  let embedding: EmbeddingProvider;
  let storage: StorageManager;

  beforeEach(() => {
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
          id: 'distilled-t1-id',
          summary: 'We deploy via GitHub Actions.',
          type: 'semantic',
          content: 'We deploy via GitHub Actions.',
          created_at: '2026-01-01T00:00:00.000Z',
          importance: 0.5,
          tags: [],
          derived_from: ['a', 'b'],
        })),
        insertMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        fullTextSearch: vi.fn(() => []),
      },
      qdrant: {
        // Above the T1 UPDATE threshold (0.95) so a re-clustered write of
        // near-identical content targets the prior distilled memory instead
        // of adding a new one.
        searchSimilar: vi.fn(async () => [{ id: 'distilled-t1-id', score: 0.97 }]),
      },
      updateMemory: vi.fn(),
      writeMemory: vi.fn(),
      writeMemoryWithoutVector: vi.fn(),
      deleteMemory: vi.fn(async () => true),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
  });

  it('stamps derived_from directly on a fresh ADD', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => []);
    const pipeline = new WritePipeline(config, storage, embedding);

    await pipeline.process({
      content: 'We deploy via GitHub Actions.',
      namespace: 'global',
      collection: 'general',
      type: 'semantic',
      tags: [],
      source: 'distillation',
      retention_tier: 'T1',
      derived_from: ['x', 'y', 'z'],
    });

    expect(storage.writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({ derived_from: ['x', 'y', 'z'], source: 'distillation' }),
      expect.anything(),
    );
  });

  it('UPDATEs the prior distilled memory and unions derived_from instead of duplicating', async () => {
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'We deploy via GitHub Actions (re-clustered).',
      namespace: 'global',
      collection: 'general',
      type: 'semantic',
      tags: [],
      source: 'distillation',
      retention_tier: 'T1',
      derived_from: ['b', 'c'],
    });

    expect(result[0]!.operation).toBe('UPDATE');
    expect(result[0]!.merged_with_id).toBe('distilled-t1-id');
    expect(storage.writeMemory).not.toHaveBeenCalled();
    expect(storage.updateMemory).toHaveBeenCalledWith(
      'distilled-t1-id',
      expect.objectContaining({ derived_from: ['a', 'b', 'c'] }),
      expect.anything(),
    );
  });
});

describe('WritePipeline pinned (add-inject-pinning)', () => {
  const config = {
    deduplication: { similarity_threshold: 0.92 },
    pipeline: {
      extraction_enabled: true,
      fallback_to_threshold_dedup: true,
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
      contradiction_detection: { enabled: false, timeout_ms: 5000 },
    },
  } as unknown as BrainConfig;

  let embedding: EmbeddingProvider;
  let storage: StorageManager;
  let existingMemory: { pinned: boolean } & Record<string, unknown>;

  beforeEach(() => {
    embedding = {
      model: 'test-model',
      dimensions: 2,
      embed: vi.fn(async () => [0.1, 0.2]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
      healthCheck: vi.fn(async () => true),
    };
    existingMemory = {
      id: 'existing-id',
      summary: 'existing summary',
      type: 'semantic',
      content: 'existing content',
      created_at: '2026-01-01T00:00:00.000Z',
      importance: 0.5,
      tags: [],
      pinned: true,
    };
    storage = {
      sqlite: {
        getMemoryByChecksum: vi.fn(() => null),
        getMemoryById: vi.fn(() => existingMemory),
        insertMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        fullTextSearch: vi.fn(() => []),
      },
      qdrant: {
        searchSimilar: vi.fn(async () => []),
      },
      updateMemory: vi.fn(),
      writeMemory: vi.fn(),
      writeMemoryWithoutVector: vi.fn(),
      deleteMemory: vi.fn(async () => true),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
  });

  it('ADD defaults pinned to false when omitted (5.1)', async () => {
    const pipeline = new WritePipeline(config, storage, embedding);
    await pipeline.process({
      content: 'brand new content', namespace: 'global', collection: 'general', tags: [], source: 'cli',
    });
    expect(storage.writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: false }), expect.anything(),
    );
  });

  it('ADD sets pinned: true when explicitly requested (5.1)', async () => {
    const pipeline = new WritePipeline(config, storage, embedding);
    await pipeline.process({
      content: 'brand new pinned content', namespace: 'global', collection: 'general', tags: [], source: 'cli', pinned: true,
    });
    expect(storage.writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: true }), expect.anything(),
    );
  });

  it('UPDATE omitting pinned preserves the existing memory\'s pin state (5.2)', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'existing-id', score: 0.95 }]);
    const pipeline = new WritePipeline(config, storage, embedding);

    await pipeline.process({
      content: 'a refinement of the existing pinned memory', namespace: 'global', collection: 'general', tags: [], source: 'cli',
    });

    expect(storage.updateMemory).toHaveBeenCalledWith(
      'existing-id', expect.objectContaining({ pinned: true }), expect.anything(),
    );
  });

  it('UPDATE with an explicit pinned: false overrides an existing pinned memory (5.3)', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'existing-id', score: 0.95 }]);
    const pipeline = new WritePipeline(config, storage, embedding);

    await pipeline.process({
      content: 'a refinement that unpins', namespace: 'global', collection: 'general', tags: [], source: 'cli', pinned: false,
    });

    expect(storage.updateMemory).toHaveBeenCalledWith(
      'existing-id', expect.objectContaining({ pinned: false }), expect.anything(),
    );
  });

  it('UPDATE with an explicit pinned: true pins a previously-unpinned memory', async () => {
    existingMemory.pinned = false;
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'existing-id', score: 0.95 }]);
    const pipeline = new WritePipeline(config, storage, embedding);

    await pipeline.process({
      content: 'a refinement that pins', namespace: 'global', collection: 'general', tags: [], source: 'cli', pinned: true,
    });

    expect(storage.updateMemory).toHaveBeenCalledWith(
      'existing-id', expect.objectContaining({ pinned: true }), expect.anything(),
    );
  });
});

describe('WritePipeline dedup candidate window corroboration', () => {
  // Tier T2 (source: 'cli') resolves thresholds to { noop: 0.98, update: 0.92 }
  // via dedupThresholdFor with similarity_threshold: 0.92 (see
  // src/domain/lifecycle.ts). corroboration_margin: 0.03 means candidates
  // scoring >= 0.89 count toward corroboration.
  const config = {
    deduplication: {
      similarity_threshold: 0.92,
      candidate_window: 5,
      corroboration_enabled: true,
      corroboration_count: 2,
      corroboration_margin: 0.03,
    },
    pipeline: {
      extraction_enabled: true,
      fallback_to_threshold_dedup: true,
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
      contradiction_detection: { enabled: false, timeout_ms: 5000 },
    },
  } as unknown as BrainConfig;

  let embedding: EmbeddingProvider;
  let storage: StorageManager;

  beforeEach(() => {
    vi.mocked(checkEntailment).mockReset();
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
          id: 'top-id',
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
        // Below the 0.92 update threshold individually, but 3 candidates sit
        // within the 0.03 corroboration margin (i.e. >= 0.89).
        searchSimilar: vi.fn(async () => [
          { id: 'top-id', score: 0.91 },
          { id: 'second-id', score: 0.90 },
          { id: 'third-id', score: 0.89 },
        ]),
      },
      updateMemory: vi.fn(),
      writeMemory: vi.fn(),
      writeMemoryWithoutVector: vi.fn(),
      deleteMemory: vi.fn(async () => true),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
  });

  it('classifies UPDATE targeting the highest-scoring candidate when a corroborated cluster is found', async () => {
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'a near-restatement of several existing memories',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('UPDATE');
    expect(result[0]!.merged_with_id).toBe('top-id');
    expect(storage.updateMemory).toHaveBeenCalledTimes(1);
    expect(storage.writeMemory).not.toHaveBeenCalled();
  });

  it('falls back to ADD when fewer than corroboration_count candidates qualify', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [
      { id: 'top-id', score: 0.91 },
      { id: 'second-id', score: 0.50 },
      { id: 'third-id', score: 0.40 },
    ]);
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'content close to only one prior memory',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('ADD');
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
    expect(storage.updateMemory).not.toHaveBeenCalled();
  });

  it('restores pre-widening ADD behavior when corroboration_enabled is false', async () => {
    const disabledConfig = {
      ...config,
      deduplication: { ...config.deduplication, corroboration_enabled: false },
    } as unknown as BrainConfig;
    const pipeline = new WritePipeline(disabledConfig, storage, embedding);

    const result = await pipeline.process({
      content: 'a near-restatement of several existing memories',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('ADD');
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
    expect(storage.updateMemory).not.toHaveBeenCalled();
  });

  it('restores pre-widening ADD behavior when candidate_window is 1', async () => {
    const narrowConfig = {
      ...config,
      deduplication: { ...config.deduplication, candidate_window: 1 },
    } as unknown as BrainConfig;
    const pipeline = new WritePipeline(narrowConfig, storage, embedding);

    const result = await pipeline.process({
      content: 'a near-restatement of several existing memories',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('ADD');
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
    expect(storage.updateMemory).not.toHaveBeenCalled();
  });

  it('emits a corroborated_dedup warning log only when the corroboration path fires', async () => {
    const logger = { warn: vi.fn() };
    const pipeline = new WritePipeline(config, storage, embedding, logger);

    await pipeline.process({
      content: 'a near-restatement of several existing memories',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'corroborated_dedup',
      targetId: 'top-id',
      topScore: 0.91,
      corroborators: 3,
    }));
  });

  it('does not emit a corroborated_dedup log for a plain single-candidate ADD', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'top-id', score: 0.1 }]);
    const logger = { warn: vi.fn() };
    const pipeline = new WritePipeline(config, storage, embedding, logger);

    await pipeline.process({
      content: 'completely unrelated new content',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(logger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'corroborated_dedup' }));
  });

  it('does not emit a corroborated_dedup log for a direct single-candidate UPDATE', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'top-id', score: 0.95 }]);
    const logger = { warn: vi.fn() };
    const pipeline = new WritePipeline(config, storage, embedding, logger);

    await pipeline.process({
      content: 'a refinement of the existing memory',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(logger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'corroborated_dedup' }));
  });
});

describe('WritePipeline contradiction detection', () => {
  const enabledConfig = {
    deduplication: { similarity_threshold: 0.92 },
    pipeline: {
      extraction_enabled: true,
      fallback_to_threshold_dedup: true,
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
      contradiction_detection: { enabled: true, timeout_ms: 5000 },
    },
  } as unknown as BrainConfig;

  let embedding: EmbeddingProvider;
  let storage: StorageManager;

  beforeEach(() => {
    vi.mocked(checkEntailment).mockReset();
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
          content: 'we use MySQL for the primary database',
          created_at: '2026-01-01T00:00:00.000Z',
          importance: 0.5,
          tags: [],
        })),
        insertMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        fullTextSearch: vi.fn(() => []),
      },
      qdrant: {
        // UPDATE band: at/above `update` threshold (0.92) but below `noop` (0.98).
        searchSimilar: vi.fn(async () => [{ id: 'existing-id', score: 0.95 }]),
      },
      updateMemory: vi.fn(),
      writeMemory: vi.fn(),
      writeMemoryWithoutVector: vi.fn(),
      deleteMemory: vi.fn(async () => true),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
  });

  it('routes to DELETE when the entailment check classifies the candidate as contradict', async () => {
    vi.mocked(checkEntailment).mockResolvedValue('contradict');
    const pipeline = new WritePipeline(enabledConfig, storage, embedding);

    const result = await pipeline.process({
      content: 'We migrated to Postgres',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(checkEntailment).toHaveBeenCalledTimes(1);
    expect(result[0]!.operation).toBe('DELETE');
    expect(result[0]!.merged_with_id).toBe('existing-id');
    expect(storage.deleteMemory).toHaveBeenCalledWith('existing-id');
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
    expect(storage.updateMemory).not.toHaveBeenCalled();
  });

  it('proceeds with UPDATE when the entailment check classifies the candidate as agree', async () => {
    vi.mocked(checkEntailment).mockResolvedValue('agree');
    const pipeline = new WritePipeline(enabledConfig, storage, embedding);

    const result = await pipeline.process({
      content: 'We use MySQL as our primary database',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(checkEntailment).toHaveBeenCalledTimes(1);
    expect(result[0]!.operation).toBe('UPDATE');
    expect(result[0]!.merged_with_id).toBe('existing-id');
    expect(storage.updateMemory).toHaveBeenCalledTimes(1);
    expect(storage.deleteMemory).not.toHaveBeenCalled();
  });

  it('proceeds with UPDATE when the entailment check classifies the candidate as refine', async () => {
    vi.mocked(checkEntailment).mockResolvedValue('refine');
    const pipeline = new WritePipeline(enabledConfig, storage, embedding);

    const result = await pipeline.process({
      content: 'We use MySQL 8 as our primary database',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(checkEntailment).toHaveBeenCalledTimes(1);
    expect(result[0]!.operation).toBe('UPDATE');
    expect(storage.deleteMemory).not.toHaveBeenCalled();
  });

  it('does not invoke the entailment check when the regex fast path already matched', async () => {
    vi.mocked(checkEntailment).mockResolvedValue('agree');
    const pipeline = new WritePipeline(enabledConfig, storage, embedding);

    const result = await pipeline.process({
      content: 'That is no longer true, we use Postgres now.',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(checkEntailment).not.toHaveBeenCalled();
    expect(result[0]!.operation).toBe('DELETE');
    expect(storage.deleteMemory).toHaveBeenCalledWith('existing-id');
  });

  it('does not invoke the entailment check when contradiction_detection is disabled', async () => {
    const disabledConfig = {
      deduplication: { similarity_threshold: 0.92 },
      pipeline: {
        extraction_enabled: true,
        fallback_to_threshold_dedup: true,
        extraction_model: 'gpt-4o-mini',
        extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
        contradiction_detection: { enabled: false, timeout_ms: 5000 },
      },
    } as unknown as BrainConfig;
    const pipeline = new WritePipeline(disabledConfig, storage, embedding);

    const result = await pipeline.process({
      content: 'We migrated to Postgres',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(checkEntailment).not.toHaveBeenCalled();
    expect(result[0]!.operation).toBe('UPDATE');
    expect(storage.deleteMemory).not.toHaveBeenCalled();
  });

  it('fails open to UPDATE and logs a degraded-path warning when the entailment check throws', async () => {
    vi.mocked(checkEntailment).mockRejectedValue(new Error('entailment check timed out after 5000ms'));
    const logger = { warn: vi.fn() };
    const pipeline = new WritePipeline(enabledConfig, storage, embedding, logger);

    const result = await pipeline.process({
      content: 'We migrated to Postgres',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('UPDATE');
    expect(storage.updateMemory).toHaveBeenCalledTimes(1);
    expect(storage.deleteMemory).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'contradiction_check_degraded',
      namespace: 'global',
      collection: 'general',
      error: 'entailment check timed out after 5000ms',
    }));
  });
});

describe('WritePipeline multi-candidate extraction', () => {
  const config = {
    deduplication: { similarity_threshold: 0.92 },
    pipeline: {
      extraction_enabled: true,
      fallback_to_threshold_dedup: true,
      extraction_model: 'gpt-4o-mini',
      extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
      extraction_min_chars: 20,
      extraction_max_candidates: 6,
      extraction_timeout_ms: 4000,
      contradiction_detection: { enabled: false, timeout_ms: 5000 },
    },
  } as unknown as BrainConfig;

  let embedding: EmbeddingProvider;
  let storage: StorageManager;
  let extraction: ExtractionProvider;

  beforeEach(() => {
    vi.mocked(checkEntailment).mockReset();
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
        getMemoryById: vi.fn(() => null),
        insertMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        fullTextSearch: vi.fn(() => []),
      },
      qdrant: {
        searchSimilar: vi.fn(async () => []),
      },
      updateMemory: vi.fn(),
      writeMemory: vi.fn(),
      writeMemoryWithoutVector: vi.fn(),
      deleteMemory: vi.fn(async () => true),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
    extraction = { extractCandidates: vi.fn(async () => null) };
  });

  it('never invokes the extraction provider below extraction_min_chars, emitting a single candidate', async () => {
    extraction.extractCandidates = vi.fn(async () => [{ content: 'should not be used' }]);
    const pipeline = new WritePipeline(config, storage, embedding, undefined, extraction);

    const result = await pipeline.process({
      content: 'short',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(extraction.extractCandidates).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
  });

  it('invokes the extraction provider at or above extraction_min_chars and writes N independent candidates', async () => {
    extraction.extractCandidates = vi.fn(async () => [
      { content: 'Alice owns the infra repo', type: 'semantic', importance: 0.7 },
      { content: 'Deploys go through GitHub Actions' },
      { content: 'We use pnpm instead of npm' },
    ]);
    const pipeline = new WritePipeline(config, storage, embedding, undefined, extraction);

    const result = await pipeline.process({
      content: 'We use pnpm not npm, deploys go through GitHub Actions, and Alice owns the infra repo',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(extraction.extractCandidates).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(3);
    expect(result.every(r => r.operation === 'ADD')).toBe(true);
    expect(storage.writeMemory).toHaveBeenCalledTimes(3);
  });

  it('falls back to the single-candidate path when the extraction provider returns null', async () => {
    extraction.extractCandidates = vi.fn(async () => null);
    const pipeline = new WritePipeline(config, storage, embedding, undefined, extraction);

    const result = await pipeline.process({
      content: 'a sufficiently long single-fact piece of content to clear the gate',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result).toHaveLength(1);
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
  });

  it('falls back to the single-candidate path when the extraction provider throws', async () => {
    extraction.extractCandidates = vi.fn(async () => { throw new Error('extraction backend down'); });
    const pipeline = new WritePipeline(config, storage, embedding, undefined, extraction);

    const result = await pipeline.process({
      content: 'a sufficiently long single-fact piece of content to clear the gate',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result).toHaveLength(1);
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
  });

  it('returns the successful WriteResults and logs/counts a mid-batch candidate failure without losing siblings', async () => {
    extraction.extractCandidates = vi.fn(async () => [
      { content: 'candidate one' },
      { content: 'candidate two' },
      { content: 'candidate three' },
    ]);
    storage.qdrant.searchSimilar = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('vector store unavailable'))
      .mockResolvedValueOnce([]);
    const logger = { warn: vi.fn() };
    const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as import('../health/metrics.js').MetricsCollector;
    const pipeline = new WritePipeline(config, storage, embedding, logger, extraction, metrics);

    const result = await pipeline.process({
      content: 'three candidates where the middle one fails during similarity search',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result).toHaveLength(2);
    expect(storage.writeMemory).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'candidate_write_failed',
      namespace: 'global',
      collection: 'general',
      candidate_index: 1,
      error: 'vector store unavailable',
    }));
    expect(metrics.incCounter).toHaveBeenCalledWith('extraction_candidate_failed_total');
  });

  it('rethrows when every candidate in the batch fails', async () => {
    extraction.extractCandidates = vi.fn(async () => [
      { content: 'candidate one' },
      { content: 'candidate two' },
    ]);
    storage.qdrant.searchSimilar = vi.fn(async () => { throw new Error('vector store unavailable'); });
    const pipeline = new WritePipeline(config, storage, embedding, undefined, extraction);

    await expect(
      pipeline.process({
        content: 'two candidates where both fail during similarity search',
        namespace: 'global',
        collection: 'general',
        tags: [],
        source: 'cli',
      }),
    ).rejects.toThrow('vector store unavailable');

    expect(storage.writeMemory).not.toHaveBeenCalled();
  });
});

describe('WritePipeline summarization', () => {
  // Heading-then-substance shape: the bug improve-memory-summarization
  // fixes is that first-line truncation picks "Meeting notes:" (no signal)
  // over the sentence that actually carries the fact.
  const multiSentenceContent = 'Meeting notes:\nAlice owns the infra repo and handles all deploys.';

  const config = {
    deduplication: { similarity_threshold: 0.92 },
    pipeline: {
      extraction_enabled: false,
      fallback_to_threshold_dedup: true,
      contradiction_detection: { enabled: false, timeout_ms: 5000 },
      summarization_enabled: false,
    },
    auto_summarize: true,
  } as unknown as BrainConfig;

  let embedding: EmbeddingProvider;
  let storage: StorageManager;

  beforeEach(() => {
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
        getMemoryById: vi.fn(() => null),
        insertMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        fullTextSearch: vi.fn(() => []),
      },
      qdrant: {
        searchSimilar: vi.fn(async () => []),
      },
      updateMemory: vi.fn(),
      writeMemory: vi.fn(),
      writeMemoryWithoutVector: vi.fn(),
      deleteMemory: vi.fn(async () => true),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
  });

  it('persists an extractive (not first-line) summary for multi-sentence content when no summarizer is configured', async () => {
    const pipeline = new WritePipeline(config, storage, embedding);

    const [result] = await pipeline.process({
      content: multiSentenceContent,
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result!.summary).toBe('Alice owns the infra repo and handles all deploys');
  });

  it('restores literal first-line truncation when auto_summarize is false', async () => {
    const disabledConfig = { ...config, auto_summarize: false } as unknown as BrainConfig;
    const pipeline = new WritePipeline(disabledConfig, storage, embedding);

    const [result] = await pipeline.process({
      content: multiSentenceContent,
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result!.summary).toBe('Meeting notes:');
  });

  it('falls back to the extractive summary when the configured LLM summarizer rejects', async () => {
    const enabledConfig = {
      ...config,
      pipeline: { ...config.pipeline, summarization_enabled: true },
    } as unknown as BrainConfig;
    const summarizer: SummarizationProvider = {
      summarize: vi.fn(async () => { throw new Error('summarizer unavailable'); }),
    };
    const pipeline = new WritePipeline(enabledConfig, storage, embedding, undefined, undefined, undefined, summarizer);

    const [result] = await pipeline.process({
      content: multiSentenceContent,
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(summarizer.summarize).toHaveBeenCalled();
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
    expect(result!.summary).toBe('Alice owns the infra repo and handles all deploys');
  });

  it('persists the LLM summarizer output when it resolves', async () => {
    const enabledConfig = {
      ...config,
      pipeline: { ...config.pipeline, summarization_enabled: true },
    } as unknown as BrainConfig;
    const summarizer: SummarizationProvider = {
      summarize: vi.fn(async () => 'LLM-produced summary'),
    };
    const pipeline = new WritePipeline(enabledConfig, storage, embedding, undefined, undefined, undefined, summarizer);

    const [result] = await pipeline.process({
      content: multiSentenceContent,
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result!.summary).toBe('LLM-produced summary');
  });
});

describe('WritePipeline auto-tagging (add-auto-tagging)', () => {
  const config = {
    deduplication: { similarity_threshold: 0.92 },
    pipeline: {
      extraction_enabled: false,
      fallback_to_threshold_dedup: true,
      contradiction_detection: { enabled: false, timeout_ms: 5000 },
      auto_tag_enabled: true,
      auto_tag_max_per_memory: 6,
    },
  } as unknown as BrainConfig;

  let embedding: EmbeddingProvider;
  let storage: StorageManager;

  beforeEach(() => {
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
        getMemoryById: vi.fn(() => null),
        insertMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        fullTextSearch: vi.fn(() => []),
      },
      qdrant: {
        searchSimilar: vi.fn(async () => []),
      },
      updateMemory: vi.fn(),
      writeMemory: vi.fn(),
      writeMemoryWithoutVector: vi.fn(),
      deleteMemory: vi.fn(async () => true),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
  });

  it('ADD with no caller tags gains auto-derived tags from content', async () => {
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'See src/pipeline/index.ts for the extractionEnabled flag.',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('ADD');
    expect(storage.writeMemory).toHaveBeenCalledTimes(1);
    const [writtenMemory] = vi.mocked(storage.writeMemory).mock.calls[0]!;
    expect(writtenMemory.tags.length).toBeGreaterThan(0);
    expect(writtenMemory.tags).toEqual(expect.arrayContaining(['extractionenabled', 'src-pipeline-index-ts']));
  });

  it('ADD with caller tags gets caller tags union auto-derived tags, caller tags first', async () => {
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'See src/pipeline/index.ts for the extractionEnabled flag.',
      namespace: 'global',
      collection: 'general',
      tags: ['manual-tag'],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('ADD');
    const [writtenMemory] = vi.mocked(storage.writeMemory).mock.calls[0]!;
    expect(writtenMemory.tags[0]).toBe('manual-tag');
    expect(writtenMemory.tags).toEqual(
      expect.arrayContaining(['manual-tag', 'extractionenabled', 'src-pipeline-index-ts']),
    );
  });

  it('UPDATE unions auto-derived tags into mergedTags like any candidate tag', async () => {
    storage.qdrant.searchSimilar = vi.fn(async () => [{ id: 'existing-id', score: 0.95 }]);
    storage.sqlite.getMemoryById = vi.fn(() => ({
      id: 'existing-id',
      summary: 'existing summary',
      type: 'semantic',
      content: 'existing content',
      created_at: '2026-01-01T00:00:00.000Z',
      importance: 0.5,
      tags: ['existing-tag'],
    }));
    const pipeline = new WritePipeline(config, storage, embedding);

    const result = await pipeline.process({
      content: 'a refinement mentioning bhgbrain/core',
      namespace: 'global',
      collection: 'general',
      tags: [],
      source: 'cli',
    });

    expect(result[0]!.operation).toBe('UPDATE');
    expect(storage.updateMemory).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(storage.updateMemory).mock.calls[0]!;
    expect(patch.tags).toEqual(expect.arrayContaining(['existing-tag', 'bhgbrain-core']));
  });

  it('never exceeds the 20-tag cap and never evicts caller-supplied tags when trimming', async () => {
    const callerTags = Array.from({ length: 18 }, (_, i) => `caller-tag-${i}`);
    // Shaped to produce more auto-tag candidates than
    // `auto_tag_max_per_memory` (6), so the union with 18 caller tags
    // exceeds the 20-tag cap and must trim auto-derived tags, not caller
    // tags.
    const content = [
      'src/pipeline/index.ts', 'src/domain/auto-tag.ts', 'src/config/index.ts',
      'bhgbrain/core', 'qdrant/qdrant', '@jsmith', '@asmith',
      'extractionEnabled', 'autoTagEnabled',
    ].join(' and ');
    const pipeline = new WritePipeline(config, storage, embedding);

    await pipeline.process({
      content,
      namespace: 'global',
      collection: 'general',
      tags: callerTags,
      source: 'cli',
    });

    const [writtenMemory] = vi.mocked(storage.writeMemory).mock.calls[0]!;
    expect(writtenMemory.tags).toHaveLength(20);
    for (const tag of callerTags) {
      expect(writtenMemory.tags).toContain(tag);
    }
  });

  it('auto_tag_enabled: false reproduces exact pass-through behavior (candidate tags identical to input.tags)', async () => {
    const disabledConfig = {
      ...config,
      pipeline: { ...config.pipeline, auto_tag_enabled: false },
    } as unknown as BrainConfig;
    const pipeline = new WritePipeline(disabledConfig, storage, embedding);

    await pipeline.process({
      content: 'See src/pipeline/index.ts for the extractionEnabled flag.',
      namespace: 'global',
      collection: 'general',
      tags: ['manual-tag'],
      source: 'cli',
    });

    const [writtenMemory] = vi.mocked(storage.writeMemory).mock.calls[0]!;
    expect(writtenMemory.tags).toEqual(['manual-tag']);
  });
});
