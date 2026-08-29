import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTool, type ToolContext } from './index.js';
import type { BrainErrorEnvelope } from '../errors/index.js';
import { embeddingUnavailable } from '../errors/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { WritePipeline } from '../pipeline/index.js';
import type { SearchService } from '../search/index.js';
import type { BackupService } from '../backup/index.js';
import type { HealthService } from '../health/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { SearchResult } from '../domain/types.js';
import type pino from 'pino';

type CollectionDeleteResult = { ok: true; deleted_memory_count: number };
type ToolResult = CollectionDeleteResult | BrainErrorEnvelope;
type TestStorage = StorageManager & {
  deleteCollectionData: ReturnType<typeof vi.fn>;
  countMemoriesInCollection: ReturnType<typeof vi.fn>;
  logAudit: ReturnType<typeof vi.fn>;
};

describe('collections delete semantics', () => {
  let ctx: ToolContext;
  let storage: TestStorage;

  beforeEach(() => {
    storage = {
      sqlite: {
        listCollections: vi.fn(() => []),
        createCollection: vi.fn(),
        flushIfDirty: vi.fn(),
        getCollection: vi.fn(() => ({ name: 'general' })),
        deleteCollection: vi.fn(() => true),
        countMemories: vi.fn(() => 0),
        listCategories: vi.fn(() => []),
      },
      countMemoriesInCollection: vi.fn(() => 3),
      deleteCollectionData: vi.fn(async () => ({ deleted: 3, ids: ['a', 'b', 'c'] })),
      logAudit: vi.fn(),
    } as unknown as TestStorage;

    ctx = {
      config: {} as ToolContext['config'],
      storage,
      embedding: { model: 'm', dimensions: 1 } as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  it('rejects deleting non-empty collection without force', async () => {
    const result = await handleTool(ctx, 'collections', { action: 'delete', name: 'general' }, 'c1') as ToolResult;
    expect(result.error.code).toBe('CONFLICT');
    expect(storage.deleteCollectionData).not.toHaveBeenCalled();
    expect(storage.sqlite.deleteCollection).not.toHaveBeenCalled();
  });

  it('force deletes collection and returns deleted memory count', async () => {
    const result = await handleTool(ctx, 'collections', {
      action: 'delete',
      namespace: 'global',
      name: 'general',
      force: true,
    }, 'c1') as ToolResult;

    expect(result.ok).toBe(true);
    expect(result.deleted_memory_count).toBe(3);
    expect(storage.deleteCollectionData).toHaveBeenCalledWith('global', 'general', { logger: ctx.logger });
    expect(storage.sqlite.deleteCollection).toHaveBeenCalledWith('global', 'general');
    expect(storage.logAudit).toHaveBeenCalledTimes(3);
    expect(ctx.metrics.setGauge).toHaveBeenCalled();
  });

  it('includes the resolved namespace in the tool_call log', async () => {
    await handleTool(ctx, 'collections', { action: 'list', namespace: 'team-a' }, 'c1');

    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'tool_call', tool: 'collections', namespace: 'team-a' }),
    );
  });

  it('includes a null namespace in the tool_call log for namespace-agnostic tools', async () => {
    await handleTool(ctx, 'category', { action: 'list' }, 'c1');

    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'tool_call', tool: 'category', namespace: null }),
    );
  });

  it('deletes empty collection without force', async () => {
    storage.countMemoriesInCollection = vi.fn(() => 0);

    const result = await handleTool(ctx, 'collections', {
      action: 'delete',
      namespace: 'global',
      name: 'general',
    }, 'c1') as ToolResult;

    expect(result.ok).toBe(true);
    expect(result.deleted_memory_count).toBe(0);
    expect(storage.deleteCollectionData).not.toHaveBeenCalled();
    expect(storage.sqlite.deleteCollection).toHaveBeenCalledWith('global', 'general');
  });

  it('surfaces collection cleanup failures instead of silently succeeding', async () => {
    storage.deleteCollectionData = vi.fn(async () => {
      throw new Error('qdrant unavailable');
    });

    const result = await handleTool(ctx, 'collections', {
      action: 'delete',
      namespace: 'global',
      name: 'general',
      force: true,
    }, 'c1') as ToolResult;

    expect(result.error.code).toBe('INTERNAL');
    expect(storage.sqlite.deleteCollection).not.toHaveBeenCalled();
  });
});

type RevisionsListResult = { id: string; revisions: Array<{ revision: number; content: string }> };
type RevisionsRevertResult = { id: string; revision: number; content: string };
type RevisionsResult = RevisionsListResult | RevisionsRevertResult | BrainErrorEnvelope;

describe('revisions tool', () => {
  const UUID = '550e8400-e29b-41d4-a716-446655440009';
  let ctx: ToolContext;
  let storage: StorageManager & { revertMemory: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    storage = {
      sqlite: {
        getMemoryById: vi.fn(() => ({ id: UUID, namespace: 'global' })),
        listRevisions: vi.fn(() => [
          { id: 2, memory_id: UUID, revision: 2, content: 'newer', updated_at: '2026-01-02T00:00:00.000Z', updated_by: null },
          { id: 1, memory_id: UUID, revision: 1, content: 'older', updated_at: '2026-01-01T00:00:00.000Z', updated_by: null },
        ]),
      },
      revertMemory: vi.fn(async (_id: string, revision: number) => ({ id: UUID, content: revision === 1 ? 'older' : 'newer' })),
    } as unknown as StorageManager & { revertMemory: ReturnType<typeof vi.fn> };

    ctx = {
      config: {} as ToolContext['config'],
      storage,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  it('lists revisions newest-first for the resolved memory', async () => {
    const result = await handleTool(ctx, 'revisions', { action: 'list', id: UUID }, 'c1') as RevisionsResult;
    expect(result.id).toBe(UUID);
    expect(result.revisions.map(r => r.revision)).toEqual([2, 1]);
  });

  it('returns NOT_FOUND when the memory does not exist', async () => {
    storage.sqlite.getMemoryById = vi.fn(() => null);
    const result = await handleTool(ctx, 'revisions', { action: 'list', id: UUID }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('rejects revert without a revision number', async () => {
    const result = await handleTool(ctx, 'revisions', { action: 'revert', id: UUID }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(storage.revertMemory).not.toHaveBeenCalled();
  });

  it('reverts through StorageManager.revertMemory and returns the restored content', async () => {
    const result = await handleTool(ctx, 'revisions', { action: 'revert', id: UUID, revision: 1 }, 'c1') as RevisionsRevertResult;
    expect(storage.revertMemory).toHaveBeenCalledWith(UUID, 1, 'c1');
    expect(result.content).toBe('older');
    expect(result.revision).toBe(1);
  });

  it('surfaces EMBEDDING_UNAVAILABLE from a failed revert without masking the error code', async () => {
    storage.revertMemory = vi.fn(async () => { throw embeddingUnavailable('provider down'); });
    const result = await handleTool(ctx, 'revisions', { action: 'revert', id: UUID, revision: 1 }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('EMBEDDING_UNAVAILABLE');
  });
});

describe('search tool include_archived wiring', () => {
  it('passes include_archived through to SearchService.search', async () => {
    const search = vi.fn(async () => []);
    const ctx: ToolContext = {
      config: { search: { mmr: { enabled: false }, rerank: { enabled: false, candidate_pool: 20 } } } as unknown as ToolContext['config'],
      storage: {} as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: { search } as unknown as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };

    await handleTool(ctx, 'search', { query: 'hello', include_archived: true }, 'c1');

    expect(search).toHaveBeenCalledWith(
      'hello', 'global', undefined, 'hybrid', 10, expect.any(Object), undefined, true,
    );
  });

  it('defaults include_archived to false', async () => {
    const search = vi.fn(async () => []);
    const ctx: ToolContext = {
      config: { search: { mmr: { enabled: false }, rerank: { enabled: false, candidate_pool: 20 } } } as unknown as ToolContext['config'],
      storage: {} as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: { search } as unknown as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };

    await handleTool(ctx, 'search', { query: 'hello' }, 'c1');

    expect(search).toHaveBeenCalledWith(
      'hello', 'global', undefined, 'hybrid', 10, expect.any(Object), undefined, false,
    );
  });
});

describe('review tool', () => {
  const UUID = '550e8400-e29b-41d4-a716-446655440010';
  type ReviewStorage = StorageManager & {
    deleteMemory: ReturnType<typeof vi.fn>;
    writeMemory: ReturnType<typeof vi.fn>;
    logAudit: ReturnType<typeof vi.fn>;
  };
  let ctx: ToolContext;
  let storage: ReviewStorage;

  beforeEach(() => {
    storage = {
      sqlite: {
        listReviewDue: vi.fn(() => []),
        getMemoryById: vi.fn(() => null),
        updateMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        archiveMemory: vi.fn(),
        deleteArchive: vi.fn(),
        getArchiveByMemoryId: vi.fn(() => null),
        countMemories: vi.fn(() => 0),
      },
      deleteMemory: vi.fn(async () => true),
      writeMemory: vi.fn(async () => {}),
      logAudit: vi.fn(),
    } as unknown as ReviewStorage;

    ctx = {
      config: { device: { id: 'local-device' } } as ToolContext['config'],
      storage,
      embedding: { embed: vi.fn(async () => [1, 2, 3]) } as unknown as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  it('list returns paginated due items oldest-first with a cursor when the page is full', async () => {
    const due = [{
      id: 'm1', namespace: 'global', collection: 'general', summary: 's1', tags: [],
      retention_tier: 'T1', review_due: '2026-01-01T00:00:00.000Z', expires_at: null,
    }];
    (storage.sqlite.listReviewDue as ReturnType<typeof vi.fn>).mockReturnValue(due);

    const result = await handleTool(ctx, 'review', { action: 'list', limit: 1 }, 'c1') as {
      items: Array<{ id: string }>; cursor: string | null;
    };

    expect(storage.sqlite.listReviewDue).toHaveBeenCalledWith('global', expect.any(String), 1, undefined);
    expect(result.items.map(i => i.id)).toEqual(['m1']);
    expect(result.cursor).toBe('2026-01-01T00:00:00.000Z|m1');
  });

  it('list returns a null cursor when the page is not full', async () => {
    (storage.sqlite.listReviewDue as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const result = await handleTool(ctx, 'review', { action: 'list' }, 'c1') as { cursor: string | null };
    expect(result.cursor).toBeNull();
  });

  it('keep re-extends review_due and expires_at per tier policy and audits a REVISE confirmation', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: UUID, namespace: 'global', retention_tier: 'T1',
    });

    const result = await handleTool(ctx, 'review', { action: 'keep', id: UUID }, 'c1') as {
      id: string; review_due: string | null; expires_at: string | null;
    };

    expect(storage.sqlite.updateMemory).toHaveBeenCalledWith(UUID, expect.objectContaining({
      review_due: expect.any(String),
      expires_at: expect.any(String),
    }));
    expect(storage.logAudit).toHaveBeenCalledWith('REVISE', UUID, 'global', 'c1', expect.objectContaining({
      details: expect.objectContaining({ action: 'revise', prior_tier: 'T1', new_tier: 'T1' }),
    }));
    expect(result.id).toBe(UUID);
    expect(result.review_due).toEqual(expect.any(String));
  });

  it('keep returns NOT_FOUND for a memory that does not exist', async () => {
    const result = await handleTool(ctx, 'review', { action: 'keep', id: UUID }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(storage.sqlite.updateMemory).not.toHaveBeenCalled();
  });

  it('archive routes through the existing archive path and audits ARCHIVE', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: UUID, namespace: 'global', retention_tier: 'T1', summary: 'x', tags: [], access_count: 0, created_at: 'now',
    });

    const result = await handleTool(ctx, 'review', { action: 'archive', id: UUID }, 'c1') as { id: string; archived: boolean };

    expect(storage.sqlite.archiveMemory).toHaveBeenCalled();
    expect(storage.deleteMemory).toHaveBeenCalledWith(UUID);
    expect(storage.logAudit).toHaveBeenCalledWith('ARCHIVE', UUID, 'global', 'c1', expect.objectContaining({
      details: expect.objectContaining({ action: 'archive', prior_tier: 'T1', new_tier: null }),
    }));
    expect(result.archived).toBe(true);
    expect(storage.sqlite.deleteArchive).not.toHaveBeenCalled();
  });

  it('rejects archiving an already-archived memory with CONFLICT', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (storage.sqlite.getArchiveByMemoryId as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 1, memory_id: UUID, summary: 's', tier: 'T1', namespace: 'global',
      created_at: 'a', expired_at: 'b', access_count: 0, tags: [],
    });

    const result = await handleTool(ctx, 'review', { action: 'archive', id: UUID }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('CONFLICT');
    expect(storage.sqlite.archiveMemory).not.toHaveBeenCalled();
  });

  it('archiving a memory that never existed fails with NOT_FOUND, not CONFLICT', async () => {
    const result = await handleTool(ctx, 'review', { action: 'archive', id: UUID }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('rolls the archive row back if the vector/row delete fails, instead of leaving both states', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: UUID, namespace: 'global', retention_tier: 'T1', summary: 'x', tags: [], access_count: 0, created_at: 'now',
    });
    storage.deleteMemory = vi.fn(async () => { throw new Error('qdrant down'); });

    await handleTool(ctx, 'review', { action: 'archive', id: UUID }, 'c1');

    expect(storage.sqlite.archiveMemory).toHaveBeenCalled();
    expect(storage.sqlite.deleteArchive).toHaveBeenCalledWith(UUID);
    expect(storage.logAudit).not.toHaveBeenCalled();
  });

  it('restore creates an active stub from the archive record, embeds it, retains the archive row, and audits RESTORE', async () => {
    (storage.sqlite.getArchiveByMemoryId as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 7, memory_id: UUID, summary: 'archived summary', tier: 'T2',
      namespace: 'global', created_at: '2025-01-01T00:00:00.000Z', expired_at: '2025-06-01T00:00:00.000Z',
      access_count: 3, tags: ['ops'],
    });

    const result = await handleTool(ctx, 'review', { action: 'restore', id: UUID }, 'c1') as {
      id: string; restored_from: string; restored: boolean;
    };

    expect(ctx.embedding.embed).toHaveBeenCalledWith('archived summary');
    expect(storage.writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'archived summary',
        summary: 'archived summary',
        tags: expect.arrayContaining(['ops', 'restored-from-archive']),
        retention_tier: 'T2',
      }),
      [1, 2, 3],
    );
    expect(storage.sqlite.deleteArchive).not.toHaveBeenCalled();
    expect(storage.logAudit).toHaveBeenCalledWith('RESTORE', expect.any(String), 'global', 'c1', expect.objectContaining({
      details: expect.objectContaining({ action: 'restore', prior_tier: null, new_tier: 'T2' }),
    }));
    expect(result.restored).toBe(true);
    expect(result.restored_from).toBe(UUID);
  });

  it('restore returns NOT_FOUND when there is no archive record for the id', async () => {
    const result = await handleTool(ctx, 'review', { action: 'restore', id: UUID }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(storage.writeMemory).not.toHaveBeenCalled();
  });

  it('rejects keep/archive/restore without an id', async () => {
    const result = await handleTool(ctx, 'review', { action: 'keep' }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

describe('consolidate tool', () => {
  const T = '550e8400-e29b-41d4-a716-446655440020';
  const S1 = '550e8400-e29b-41d4-a716-446655440021';
  const S2 = '550e8400-e29b-41d4-a716-446655440022';
  const OTHER = '550e8400-e29b-41d4-a716-446655440023';

  type ConsolidateStorage = StorageManager & {
    deleteMemory: ReturnType<typeof vi.fn>;
    updateMemory: ReturnType<typeof vi.fn>;
    logAudit: ReturnType<typeof vi.fn>;
    qdrant: { findNeighborsById: ReturnType<typeof vi.fn> };
  };

  function baseMemory(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: 'm', namespace: 'global', collection: 'general',
      summary: 's', tags: [], importance: 0.5, access_count: 0,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      retention_tier: 'T2', merged_from: null,
      ...overrides,
    };
  }

  function createCtx(config: Record<string, unknown> = {}): { ctx: ToolContext; storage: ConsolidateStorage } {
    const storage = {
      sqlite: {
        listMemoriesInCollection: vi.fn(() => []),
        getMemoryById: vi.fn(() => null),
        getArchiveByMemoryId: vi.fn(() => null),
        archiveMemory: vi.fn(),
        deleteArchive: vi.fn(),
        flushIfDirty: vi.fn(),
        countMemories: vi.fn(() => 0),
      },
      qdrant: { findNeighborsById: vi.fn(async () => []) },
      deleteMemory: vi.fn(async () => true),
      updateMemory: vi.fn(async () => {}),
      logAudit: vi.fn(),
    } as unknown as ConsolidateStorage;

    const ctx: ToolContext = {
      config: {
        consolidation: {
          enabled: true, similarity_threshold: 0.9, neighbor_top_k: 20, max_scan_per_call: 500,
          ...config,
        },
      } as unknown as ToolContext['config'],
      storage,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
    return { ctx, storage };
  }

  it('rejects any action when consolidation.enabled is false', async () => {
    const { ctx } = createCtx({ enabled: false });
    const result = await handleTool(ctx, 'consolidate', { action: 'list' }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('list clusters memories connected by a neighbor edge within the scanned page', async () => {
    const { ctx, storage } = createCtx();
    const m1 = baseMemory({ id: T, importance: 0.9 });
    const m2 = baseMemory({ id: S1, importance: 0.4 });
    const m3 = baseMemory({ id: OTHER, importance: 0.1 });
    (storage.sqlite.listMemoriesInCollection as ReturnType<typeof vi.fn>).mockReturnValue([m1, m2, m3]);
    (storage.qdrant.findNeighborsById as ReturnType<typeof vi.fn>).mockImplementation(async (_ns: string, _col: string, id: string) => {
      if (id === T) return [{ id: S1, score: 0.95 }];
      if (id === S1) return [{ id: T, score: 0.95 }];
      return [];
    });

    const result = await handleTool(ctx, 'consolidate', { action: 'list' }, 'c1') as {
      clusters: Array<{ members: Array<{ id: string }>; suggested_target: string }>; cursor: string | null;
    };

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.members.map(m => m.id).sort()).toEqual([S1, T].sort());
    // Higher importance wins the suggested_target tie-break.
    expect(result.clusters[0]!.suggested_target).toBe(T);
  });

  it('list drops clusters below min_cluster_size', async () => {
    const { ctx, storage } = createCtx();
    const m1 = baseMemory({ id: T });
    const m2 = baseMemory({ id: OTHER });
    (storage.sqlite.listMemoriesInCollection as ReturnType<typeof vi.fn>).mockReturnValue([m1, m2]);
    // No edges at all -> both memories are singleton clusters.
    (storage.qdrant.findNeighborsById as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await handleTool(ctx, 'consolidate', { action: 'list' }, 'c1') as { clusters: unknown[] };
    expect(result.clusters).toEqual([]);
  });

  it('list suggested_target ties break on access_count then most-recent updated_at', async () => {
    const { ctx, storage } = createCtx();
    const m1 = baseMemory({ id: T, importance: 0.5, access_count: 1, updated_at: '2026-01-01T00:00:00.000Z' });
    const m2 = baseMemory({ id: S1, importance: 0.5, access_count: 5, updated_at: '2026-01-02T00:00:00.000Z' });
    (storage.sqlite.listMemoriesInCollection as ReturnType<typeof vi.fn>).mockReturnValue([m1, m2]);
    (storage.qdrant.findNeighborsById as ReturnType<typeof vi.fn>).mockImplementation(async (_ns: string, _col: string, id: string) =>
      id === T ? [{ id: S1, score: 0.95 }] : [{ id: T, score: 0.95 }]);

    const result = await handleTool(ctx, 'consolidate', { action: 'list' }, 'c1') as {
      clusters: Array<{ suggested_target: string }>;
    };
    expect(result.clusters[0]!.suggested_target).toBe(S1);
  });

  it('list returns a cursor only when the scanned page is full', async () => {
    const { ctx, storage } = createCtx({ max_scan_per_call: 1 });
    const m1 = baseMemory({ id: T, created_at: '2026-01-01T00:00:00.000Z' });
    (storage.sqlite.listMemoriesInCollection as ReturnType<typeof vi.fn>).mockReturnValue([m1]);

    const result = await handleTool(ctx, 'consolidate', { action: 'list' }, 'c1') as { cursor: string | null };
    expect(result.cursor).toBe('2026-01-01T00:00:00.000Z|' + T);
  });

  it('list returns a null cursor when the page is not full', async () => {
    const { ctx, storage } = createCtx({ max_scan_per_call: 500 });
    (storage.sqlite.listMemoriesInCollection as ReturnType<typeof vi.fn>).mockReturnValue([baseMemory({ id: T })]);

    const result = await handleTool(ctx, 'consolidate', { action: 'list' }, 'c1') as { cursor: string | null };
    expect(result.cursor).toBeNull();
  });

  it('merge happy path: unions tags, maxes importance, sets merged_from, archives sources, and audits consolidate', async () => {
    const { ctx, storage } = createCtx();
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === T) return baseMemory({ id: T, tags: ['a'], importance: 0.3, merged_from: null });
      if (id === S1) return baseMemory({ id: S1, tags: ['b'], importance: 0.8 });
      return null;
    });

    const result = await handleTool(ctx, 'consolidate', {
      action: 'merge', target_id: T, source_ids: [S1],
    }, 'c1') as { target_id: string; merged: string[]; failed: string[] };

    expect(storage.updateMemory).toHaveBeenCalledWith(T, expect.objectContaining({
      tags: expect.arrayContaining(['a', 'b']),
      importance: 0.8,
      merged_from: S1,
    }));
    expect(storage.sqlite.archiveMemory).toHaveBeenCalled();
    expect(storage.deleteMemory).toHaveBeenCalledWith(S1);
    expect(storage.logAudit).toHaveBeenCalledWith('ARCHIVE', S1, 'global', 'c1', expect.objectContaining({
      details: expect.objectContaining({ action: 'consolidate', merged_into: T }),
    }));
    expect(result).toEqual({ target_id: T, merged: [S1], failed: [] });
  });

  it('merge appends to an existing merged_from rather than overwriting it', async () => {
    const { ctx, storage } = createCtx();
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === T) return baseMemory({ id: T, merged_from: 'prior-id' });
      if (id === S1) return baseMemory({ id: S1 });
      return null;
    });

    await handleTool(ctx, 'consolidate', { action: 'merge', target_id: T, source_ids: [S1] }, 'c1');

    expect(storage.updateMemory).toHaveBeenCalledWith(T, expect.objectContaining({
      merged_from: `prior-id,${S1}`,
    }));
  });

  it('merge rejects an unknown source id with NOT_FOUND and archives nothing', async () => {
    const { ctx, storage } = createCtx();
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === T ? baseMemory({ id: T }) : null);
    (storage.sqlite.getArchiveByMemoryId as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = await handleTool(ctx, 'consolidate', {
      action: 'merge', target_id: T, source_ids: [S1],
    }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('NOT_FOUND');
    expect(storage.sqlite.archiveMemory).not.toHaveBeenCalled();
  });

  it('merge rejects a source from a different collection with INVALID_INPUT and archives nothing', async () => {
    const { ctx, storage } = createCtx();
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === T) return baseMemory({ id: T, collection: 'general' });
      if (id === S1) return baseMemory({ id: S1, collection: 'other' });
      return null;
    });

    const result = await handleTool(ctx, 'consolidate', {
      action: 'merge', target_id: T, source_ids: [S1],
    }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INVALID_INPUT');
    expect(storage.sqlite.archiveMemory).not.toHaveBeenCalled();
  });

  it('merge rejects target_id inside source_ids at the schema level', async () => {
    const { ctx } = createCtx();
    const result = await handleTool(ctx, 'consolidate', {
      action: 'merge', target_id: T, source_ids: [T],
    }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('idempotent retry: an already-archived source is skipped, not failed, and the rest still merge', async () => {
    const { ctx, storage } = createCtx();
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === T) return baseMemory({ id: T });
      if (id === S2) return baseMemory({ id: S2 });
      return null; // S1 not found live
    });
    (storage.sqlite.getArchiveByMemoryId as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === S1 ? { id: 1, memory_id: S1 } : null);

    const result = await handleTool(ctx, 'consolidate', {
      action: 'merge', target_id: T, source_ids: [S1, S2],
    }, 'c1') as { target_id: string; merged: string[]; failed: string[] };

    expect(result.merged).toEqual([S2]);
    expect(result.failed).toEqual([]);
    expect(storage.deleteMemory).toHaveBeenCalledWith(S2);
    expect(storage.deleteMemory).not.toHaveBeenCalledWith(S1);
  });

  it('partial failure: a mid-loop deleteMemory throw leaves the failed source unarchived and reports both lists', async () => {
    const { ctx, storage } = createCtx();
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === T) return baseMemory({ id: T });
      if (id === S1) return baseMemory({ id: S1 });
      if (id === S2) return baseMemory({ id: S2 });
      return null;
    });
    storage.deleteMemory = vi.fn(async (id: string) => {
      if (id === S1) throw new Error('qdrant down');
      return true;
    });

    const result = await handleTool(ctx, 'consolidate', {
      action: 'merge', target_id: T, source_ids: [S1, S2],
    }, 'c1') as { target_id: string; merged: string[]; failed: string[] };

    expect(result.merged).toEqual([S2]);
    expect(result.failed).toEqual([S1]);
    expect(storage.sqlite.deleteArchive).toHaveBeenCalledWith(S1);
    expect(storage.sqlite.deleteArchive).not.toHaveBeenCalledWith(S2);
  });
});

type RepairResult = {
  dry_run: boolean;
  all_devices: boolean;
  device_id_filter: string | null;
  recovered: number;
  skipped_device_filter?: number;
};

describe('repair device filtering', () => {
  function createRepairCtx(points: Array<{ id: string; payload: Record<string, unknown> }>) {
    const qdrant = {
      listAllCollections: vi.fn(async () => ['bhgbrain_global_general']),
      scrollAll: vi.fn(async () => points),
    };
    const sqlite = {
      getMemoryById: vi.fn(() => null),
      getCollection: vi.fn(() => ({ name: 'general' })),
      createCollection: vi.fn(),
      insertMemory: vi.fn(),
      flushIfDirty: vi.fn(),
      countMemories: vi.fn(() => 0),
    };
    const storage = { qdrant, sqlite } as unknown as StorageManager;
    const ctx: ToolContext = {
      config: { device: { id: 'local-device' } } as ToolContext['config'],
      storage,
      embedding: { model: 'm', dimensions: 1 } as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
    return { ctx, sqlite };
  }

  const twoDevicePoints = [
    { id: 'p-a', payload: { content: 'from device a', device_id: 'device-a', namespace: 'global', collection: 'general' } },
    { id: 'p-b', payload: { content: 'from device b', device_id: 'device-b', namespace: 'global', collection: 'general' } },
  ];

  it('recovers only the requested device when device_id is provided', async () => {
    const { ctx, sqlite } = createRepairCtx(twoDevicePoints);

    const result = await handleTool(ctx, 'repair', { device_id: 'device-a' }, 'c1') as RepairResult;

    expect(result.recovered).toBe(1);
    expect(result.device_id_filter).toBe('device-a');
    expect(result.all_devices).toBe(false);
    expect(sqlite.insertMemory).toHaveBeenCalledTimes(1);
    expect(sqlite.insertMemory).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-a', device_id: 'device-a' }));
  });

  it('recovers points from every device when all_devices is explicitly true', async () => {
    const { ctx, sqlite } = createRepairCtx(twoDevicePoints);

    const result = await handleTool(ctx, 'repair', { all_devices: true }, 'c1') as RepairResult;

    expect(result.recovered).toBe(2);
    expect(result.all_devices).toBe(true);
    expect(result.device_id_filter).toBeNull();
    expect(sqlite.insertMemory).toHaveBeenCalledTimes(2);
  });

  it('recovers points from every device when neither filter is provided (backward-compatible default)', async () => {
    const { ctx, sqlite } = createRepairCtx(twoDevicePoints);

    const result = await handleTool(ctx, 'repair', {}, 'c1') as RepairResult;

    expect(result.recovered).toBe(2);
    expect(result.all_devices).toBe(true);
    expect(sqlite.insertMemory).toHaveBeenCalledTimes(2);
  });

  it('sets the local device_id on a recovered record whose original payload has none', async () => {
    const { ctx, sqlite } = createRepairCtx([
      { id: 'p-legacy', payload: { content: 'pre-migration memory', namespace: 'global', collection: 'general' } },
    ]);

    const result = await handleTool(ctx, 'repair', {}, 'c1') as RepairResult;

    expect(result.recovered).toBe(1);
    expect(sqlite.insertMemory).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-legacy', device_id: 'local-device' }));
  });

  it('rejects device_id and all_devices together as mutually exclusive', async () => {
    const { ctx } = createRepairCtx(twoDevicePoints);

    const result = await handleTool(ctx, 'repair', { device_id: 'device-a', all_devices: true }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

// openspec/changes/stamp-embedding-provenance
describe('repair mode: re-embed', () => {
  type ReembedResult = {
    mode: string;
    dry_run: boolean;
    active_identity: string;
    include_legacy: boolean;
    updated?: number;
    failed?: number;
    remaining?: number;
    would_re_embed?: number;
  };

  function createReembedCtx(overrides: Partial<{
    getExpectedEmbeddingIdentity: () => string | null;
    countStale: () => number;
    reembedMismatchedVectors: ReturnType<typeof vi.fn>;
  }> = {}) {
    const storage = {
      sqlite: {
        countMemories: vi.fn(() => 5),
        countMemoriesWithStaleEmbeddingStamp: vi.fn(overrides.countStale ?? (() => 3)),
      },
      getExpectedEmbeddingIdentity: vi.fn(overrides.getExpectedEmbeddingIdentity ?? (() => 'azure-foundry/old@1536')),
      reembedMismatchedVectors: overrides.reembedMismatchedVectors
        ?? vi.fn(async () => ({ updated: 3, failed: 0, remaining: 0, boundReached: false, converged: true })),
    } as unknown as StorageManager;
    const ctx: ToolContext = {
      config: {} as ToolContext['config'],
      storage,
      embedding: { provider: 'openai', model: 'm', dimensions: 3, identity: 'openai/m@3' } as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
    return { ctx, storage };
  }

  it('dry_run reports the stale count without calling reembedMismatchedVectors', async () => {
    const { ctx, storage } = createReembedCtx();

    const result = await handleTool(ctx, 'repair', { mode: 're-embed', dry_run: true }, 'c1') as ReembedResult;

    expect(result.dry_run).toBe(true);
    expect(result.would_re_embed).toBe(3);
    expect(result.active_identity).toBe('openai/m@3');
    expect(storage.reembedMismatchedVectors).not.toHaveBeenCalled();
  });

  it('a real run delegates to StorageManager.reembedMismatchedVectors and reports its outcome', async () => {
    const { ctx, storage } = createReembedCtx();

    const result = await handleTool(ctx, 'repair', {
      mode: 're-embed', include_legacy: true, batch_size: 25,
    }, 'c1') as ReembedResult;

    expect(storage.reembedMismatchedVectors).toHaveBeenCalledWith(
      expect.objectContaining({ includeLegacy: true, batchSize: 25 }),
    );
    expect(result.updated).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

describe('tool input contracts', () => {
  // Input validation happens (via strict Zod schemas) before any dependency is
  // touched, so a bare ctx with metrics + logger is enough to exercise rejection.
  function createCtx(): ToolContext {
    return {
      config: {} as ToolContext['config'],
      storage: {} as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  }

  const UUID = '550e8400-e29b-41d4-a716-446655440000';

  // For each tool: an input with an unknown field, and one with an out-of-bounds /
  // invalid value. Strict schemas must reject both with an INVALID_INPUT envelope.
  const cases: Array<{ tool: string; unknownField: unknown; outOfBounds: unknown }> = [
    { tool: 'recall', unknownField: { query: 'hi', bogus: 1 }, outOfBounds: { query: 'hi', limit: 21 } },
    { tool: 'search', unknownField: { query: 'hi', bogus: 1 }, outOfBounds: { query: 'hi', limit: 51 } },
    { tool: 'tag', unknownField: { id: UUID, bogus: 1 }, outOfBounds: { id: 'not-a-uuid' } },
    { tool: 'revisions', unknownField: { action: 'list', id: UUID, bogus: 1 }, outOfBounds: { action: 'list', id: 'not-a-uuid' } },
    { tool: 'category', unknownField: { action: 'list', bogus: 1 }, outOfBounds: { action: 'bogus' } },
    { tool: 'backup', unknownField: { action: 'list', bogus: 1 }, outOfBounds: { action: 'bogus' } },
  ];

  for (const { tool, unknownField, outOfBounds } of cases) {
    it(`${tool} rejects an unknown field with INVALID_INPUT`, async () => {
      const result = await handleTool(createCtx(), tool, unknownField, 'c1') as BrainErrorEnvelope;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it(`${tool} rejects an out-of-bounds/invalid value with INVALID_INPUT`, async () => {
      const result = await handleTool(createCtx(), tool, outOfBounds, 'c1') as BrainErrorEnvelope;
      expect(result.error.code).toBe('INVALID_INPUT');
    });
  }
});

describe('tool-handler latency recording (record-tool-latency-on-all-paths)', () => {
  // A bare ctx is enough: dispatch fails validation/lookup before touching
  // storage, embedding, etc. — same rationale as `tool input contracts` above.
  function createCtx(overrides?: { storage?: Partial<StorageManager> }): ToolContext {
    return {
      config: {} as ToolContext['config'],
      storage: (overrides?.storage ?? {}) as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  }

  it('records a tool-handler latency sample when dispatch throws a BrainError (task 4.1)', async () => {
    const ctx = createCtx();

    const result = await handleTool(ctx, 'unknown_tool', {}, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INVALID_INPUT');
    expect(ctx.metrics.recordHistogram).toHaveBeenCalledWith(
      'bhgbrain_tool_handler_ms',
      expect.any(Number),
      { tool: 'unknown_tool', status: 'error' },
    );
  });

  it('records a tool-handler latency sample when dispatch throws an unexpected error (task 4.1)', async () => {
    const ctx = createCtx({
      storage: { sqlite: {
        getCategory: () => { throw new Error('boom'); },
      } } as unknown as Partial<StorageManager>,
    });

    const result = await handleTool(ctx, 'category', { action: 'get', name: 'x' }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INTERNAL');
    expect(ctx.metrics.recordHistogram).toHaveBeenCalledWith(
      'bhgbrain_tool_handler_ms',
      expect.any(Number),
      { tool: 'category', status: 'error' },
    );
  });

  it('identifies latency per tool so two different tools produce distinguishable entries (task 4.2)', async () => {
    const ctx = createCtx({
      storage: { sqlite: {
        listCategories: () => [],
        listCollections: () => [],
      } } as unknown as Partial<StorageManager>,
    });

    await handleTool(ctx, 'category', { action: 'list' }, 'c1');
    await handleTool(ctx, 'collections', { action: 'list', namespace: 'global' }, 'c1');

    const recordHistogram = ctx.metrics.recordHistogram as ReturnType<typeof vi.fn>;
    const toolLabels = recordHistogram.mock.calls
      .filter(call => call[0] === 'bhgbrain_tool_handler_ms')
      .map(call => (call[2] as { tool: string }).tool);

    expect(toolLabels).toContain('category');
    expect(toolLabels).toContain('collections');
    expect(new Set(toolLabels).size).toBe(2);
  });

  it('records a tool-handler latency sample on the success path with an "ok" status label', async () => {
    const ctx = createCtx({
      storage: { sqlite: { listCategories: () => [] } } as unknown as Partial<StorageManager>,
    });

    await handleTool(ctx, 'category', { action: 'list' }, 'c1');

    expect(ctx.metrics.recordHistogram).toHaveBeenCalledWith(
      'bhgbrain_tool_handler_ms',
      expect.any(Number),
      { tool: 'category', status: 'ok' },
    );
  });
});

describe('handleRecall filter pushdown and score semantics (push-down-recall-filters)', () => {
  let ctx: ToolContext;
  let searchMock: ReturnType<typeof vi.fn>;

  function makeResult(overrides: Partial<SearchResult> & { id: string }): SearchResult {
    return {
      content: 'content',
      summary: 'summary',
      type: 'semantic',
      tags: [],
      score: 0.9,
      retention_tier: 'T2',
      expires_at: null,
      expiring_soon: false,
      device_id: null,
      created_at: '2026-01-01T00:00:00Z',
      last_accessed: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    searchMock = vi.fn(async () => [] as SearchResult[]);
    ctx = {
      config: { search: { mmr: { enabled: false }, rerank: { enabled: false, candidate_pool: 20 } } } as unknown as ToolContext['config'],
      storage: {} as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: { search: searchMock } as unknown as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  it('pushes a type filter into the search call and over-fetches beyond limit', async () => {
    await handleTool(ctx, 'recall', { query: 'q', type: 'procedural', limit: 5 }, 'c1');
    expect(searchMock).toHaveBeenCalledWith(
      'q', 'global', undefined, 'semantic', 10, undefined, { type: 'procedural', tags: undefined },
    );
  });

  it('does not pass a filter argument when neither type nor tags are requested', async () => {
    await handleTool(ctx, 'recall', { query: 'q', limit: 5 }, 'c1');
    expect(searchMock).toHaveBeenCalledWith('q', 'global', undefined, 'semantic', 10, undefined, undefined);
  });

  it('returns up to limit matching results instead of starving on non-matching top candidates (regression)', async () => {
    // Simulates the store already having pushed the type filter down: all
    // returned candidates match, so the caller's limit counts matches, not
    // unfiltered top-K survivors.
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeResult({ id: `m${i}`, type: 'procedural', score: 0.9 - i * 0.01, semantic_score: 0.9 - i * 0.01 }));
    searchMock.mockResolvedValue(matches);

    const result = await handleTool(ctx, 'recall', { query: 'q', type: 'procedural', limit: 5 }, 'c1') as { results: SearchResult[] };

    expect(result.results).toHaveLength(5);
    expect(result.results.every(r => r.type === 'procedural')).toBe(true);
  });

  it('applies min_score to semantic_score, not a mode-adjusted score (guard: task 2.3)', async () => {
    // A result whose fused/T0-boosted `score` clears min_score but whose
    // semantic_score does not must still be dropped: min_score is calibrated
    // for cosine similarity, and recall hardcodes semantic mode.
    searchMock.mockResolvedValue([
      makeResult({ id: 'boosted-but-not-similar', score: 0.75, semantic_score: 0.4 }),
      makeResult({ id: 'genuinely-similar', score: 0.75, semantic_score: 0.75 }),
    ]);

    const result = await handleTool(ctx, 'recall', { query: 'q', min_score: 0.6, limit: 5 }, 'c1') as { results: SearchResult[] };

    expect(result.results.map(r => r.id)).toEqual(['genuinely-similar']);
  });

  it('increments recall_zero_after_filter when the defensive re-check removes a store-returned result', async () => {
    // The store claimed a match but the payload disagrees (e.g. drift) —
    // exactly the filter-starvation symptom this metric exists to surface.
    searchMock.mockResolvedValue([
      makeResult({ id: 'wrong-type', type: 'episodic', score: 0.9, semantic_score: 0.9 }),
    ]);

    await handleTool(ctx, 'recall', { query: 'q', type: 'procedural', limit: 5 }, 'c1');

    expect(ctx.metrics.incCounter).toHaveBeenCalledWith('recall_zero_after_filter');
  });

  it('does not increment recall_zero_after_filter when the store already returned only matching results', async () => {
    searchMock.mockResolvedValue([
      makeResult({ id: 'right-type', type: 'procedural', score: 0.9, semantic_score: 0.9 }),
    ]);

    await handleTool(ctx, 'recall', { query: 'q', type: 'procedural', limit: 5 }, 'c1');

    expect(ctx.metrics.incCounter).not.toHaveBeenCalledWith('recall_zero_after_filter');
  });

  // add-mmr-diversity-reranking task 6.5: min_score is applied to
  // semantic_score *after* SearchService's MMR reorder has already run (the
  // reorder happens inside the mocked `search()` call here, so this
  // simulates its output — an interleaved, non-relevance-sorted pool).
  // `handleRecall` must still filter correctly and return up to `limit`
  // whenever enough pool candidates clear `min_score`, regardless of order.
  it('min_score still filters correctly and returns up to limit given an MMR-reordered (interleaved) pool', async () => {
    const mmrEnabledCtx: ToolContext = {
      ...ctx,
      config: { search: { mmr: {
        enabled: true, lambda: 0.7, candidate_pool_multiplier: 3, candidate_pool_cap: 50,
      }, rerank: { enabled: false, candidate_pool: 20 } } } as unknown as ToolContext['config'],
    };
    // 6 qualifying (semantic_score >= 0.5) interleaved with 2 non-qualifying,
    // in an order that does not follow relevance ranking (as MMR's reorder
    // would produce) — the widened pool a config-driven fetchLimit fetches.
    searchMock.mockResolvedValue([
      makeResult({ id: 'good-1', score: 0.9, semantic_score: 0.9 }),
      makeResult({ id: 'bad-1', score: 0.4, semantic_score: 0.3 }),
      makeResult({ id: 'good-2', score: 0.6, semantic_score: 0.55 }),
      makeResult({ id: 'good-3', score: 0.85, semantic_score: 0.8 }),
      makeResult({ id: 'bad-2', score: 0.45, semantic_score: 0.2 }),
      makeResult({ id: 'good-4', score: 0.7, semantic_score: 0.65 }),
      makeResult({ id: 'good-5', score: 0.75, semantic_score: 0.7 }),
      makeResult({ id: 'good-6', score: 0.65, semantic_score: 0.6 }),
    ]);

    const result = await handleTool(
      mmrEnabledCtx, 'recall', { query: 'q', min_score: 0.5, limit: 5 }, 'c1',
    ) as { results: SearchResult[] };

    expect(result.results).toHaveLength(5);
    expect(result.results.every(r => (r.semantic_score ?? r.score) >= 0.5)).toBe(true);
    expect(result.results.some(r => r.id === 'bad-1' || r.id === 'bad-2')).toBe(false);
  });
});

describe('handleRecall rerank stage (add-opt-in-rerank-stage)', () => {
  function makeResult(overrides: Partial<SearchResult> & { id: string }): SearchResult {
    return {
      content: 'content',
      summary: 'summary',
      type: 'semantic',
      tags: [],
      score: 0.9,
      retention_tier: 'T2',
      expires_at: null,
      expiring_soon: false,
      device_id: null,
      created_at: '2026-01-01T00:00:00Z',
      last_accessed: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  function makeCtx(
    rerankEnabled: boolean,
    searchMock: ReturnType<typeof vi.fn>,
    rerankMock: ReturnType<typeof vi.fn>,
  ): ToolContext {
    return {
      config: {
        search: {
          mmr: { enabled: false },
          rerank: { enabled: rerankEnabled, candidate_pool: 20 },
        },
      } as unknown as ToolContext['config'],
      storage: {} as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: { search: searchMock, rerank: rerankMock } as unknown as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  }

  it('calls ctx.search.rerank with the candidate pool and applies min_score/limit to the reranked list when enabled', async () => {
    const preRerank = [
      makeResult({ id: 'a', score: 0.5, semantic_score: 0.5 }),
      makeResult({ id: 'b', score: 0.4, semantic_score: 0.4 }),
    ];
    const searchMock = vi.fn(async () => preRerank);
    // Simulates SearchService.rerank's contract: full list, re-sorted, with
    // rerank_score populated on the (here, both) scored candidates.
    const reranked = [
      makeResult({ id: 'b', score: 0.95, semantic_score: 0.4, rerank_score: 0.95 }),
      makeResult({ id: 'a', score: 0.1, semantic_score: 0.5, rerank_score: 0.1 }),
    ];
    const rerankMock = vi.fn(async () => reranked);
    const ctx = makeCtx(true, searchMock, rerankMock);

    const result = await handleTool(
      ctx, 'recall', { query: 'q', limit: 5, min_score: 0 }, 'c1',
    ) as { results: SearchResult[] };

    expect(rerankMock).toHaveBeenCalledWith('q', preRerank, 20);
    // Ordering reflects the reranked list, not the pre-rerank order.
    expect(result.results.map(r => r.id)).toEqual(['b', 'a']);
    expect(result.results[0]?.rerank_score).toBe(0.95);
  });

  it('does not call ctx.search.rerank and is unaffected when disabled (default)', async () => {
    const preRerank = [makeResult({ id: 'a', score: 0.9, semantic_score: 0.9 })];
    const searchMock = vi.fn(async () => preRerank);
    const rerankMock = vi.fn();
    const ctx = makeCtx(false, searchMock, rerankMock);

    const result = await handleTool(ctx, 'recall', { query: 'q', limit: 5 }, 'c1') as { results: SearchResult[] };

    expect(rerankMock).not.toHaveBeenCalled();
    expect(result.results).toEqual(preRerank);
  });

  it('does not throw, increments search_rerank_degraded, and returns pre-rerank ordering on rerank failure', async () => {
    const preRerank = [
      makeResult({ id: 'a', score: 0.9, semantic_score: 0.9 }),
      makeResult({ id: 'b', score: 0.8, semantic_score: 0.8 }),
    ];
    const searchMock = vi.fn(async () => preRerank);
    const rerankMock = vi.fn(async () => { throw new Error('rerank api down'); });
    const ctx = makeCtx(true, searchMock, rerankMock);

    const result = await handleTool(ctx, 'recall', { query: 'q', limit: 5 }, 'c1') as { results: SearchResult[] };

    expect(result.results.map(r => r.id)).toEqual(['a', 'b']);
    expect(ctx.metrics.incCounter).toHaveBeenCalledWith('search_rerank_degraded');
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'rerank_degraded' }));
  });
});

describe('handleRecall after/before pushdown (add-time-scoped-recall)', () => {
  let ctx: ToolContext;
  let searchMock: ReturnType<typeof vi.fn>;

  function makeResult(overrides: Partial<SearchResult> & { id: string }): SearchResult {
    return {
      content: 'content',
      summary: 'summary',
      type: 'semantic',
      tags: [],
      score: 0.9,
      semantic_score: 0.9,
      retention_tier: 'T2',
      expires_at: null,
      expiring_soon: false,
      device_id: null,
      created_at: '2026-03-01T00:00:00Z',
      last_accessed: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    searchMock = vi.fn(async () => [] as SearchResult[]);
    ctx = {
      config: { search: { mmr: { enabled: false }, rerank: { enabled: false, candidate_pool: 20 } } } as unknown as ToolContext['config'],
      storage: {} as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: { search: searchMock } as unknown as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  it('pushes after/before into the search call filter', async () => {
    await handleTool(ctx, 'recall', {
      query: 'q', after: '2026-01-01T00:00:00Z', before: '2026-06-01T00:00:00Z', limit: 5,
    }, 'c1');
    expect(searchMock).toHaveBeenCalledWith(
      'q', 'global', undefined, 'semantic', 10, undefined,
      { type: undefined, tags: undefined, after: '2026-01-01T00:00:00Z', before: '2026-06-01T00:00:00Z' },
    );
  });

  it('returns up to limit in-window matches instead of starving on out-of-window top candidates (regression)', async () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeResult({ id: `m${i}`, score: 0.9 - i * 0.01, semantic_score: 0.9 - i * 0.01 }));
    searchMock.mockResolvedValue(matches);

    const result = await handleTool(ctx, 'recall', {
      query: 'q', after: '2026-01-01T00:00:00Z', before: '2026-06-01T00:00:00Z', limit: 5,
    }, 'c1') as { results: SearchResult[] };

    expect(result.results).toHaveLength(5);
  });

  it('increments recall_zero_after_filter when the defensive re-check removes an out-of-window result', async () => {
    searchMock.mockResolvedValue([
      makeResult({ id: 'too-old', created_at: '2025-01-01T00:00:00Z' }),
    ]);

    await handleTool(ctx, 'recall', { query: 'q', after: '2026-01-01T00:00:00Z', limit: 5 }, 'c1');

    expect(ctx.metrics.incCounter).toHaveBeenCalledWith('recall_zero_after_filter');
  });

  it('does not increment recall_zero_after_filter when the store already returned only in-window results', async () => {
    searchMock.mockResolvedValue([
      makeResult({ id: 'in-window', created_at: '2026-03-01T00:00:00Z' }),
    ]);

    await handleTool(ctx, 'recall', { query: 'q', after: '2026-01-01T00:00:00Z', limit: 5 }, 'c1');

    expect(ctx.metrics.incCounter).not.toHaveBeenCalledWith('recall_zero_after_filter');
  });
});

describe('handleSearch after/before pushdown (add-time-scoped-recall)', () => {
  let ctx: ToolContext;
  let searchMock: ReturnType<typeof vi.fn>;

  function makeResult(overrides: Partial<SearchResult> & { id: string }): SearchResult {
    return {
      content: 'content',
      summary: 'summary',
      type: 'semantic',
      tags: [],
      score: 0.9,
      retention_tier: 'T2',
      expires_at: null,
      expiring_soon: false,
      device_id: null,
      created_at: '2026-03-01T00:00:00Z',
      last_accessed: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    searchMock = vi.fn(async () => [] as SearchResult[]);
    ctx = {
      config: { search: { mmr: { enabled: false }, rerank: { enabled: false, candidate_pool: 20 } } } as unknown as ToolContext['config'],
      storage: {} as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: { search: searchMock } as unknown as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  it('builds and passes a filter when after/before bounds are given', async () => {
    await handleTool(ctx, 'search', {
      query: 'q', after: '2026-01-01T00:00:00Z', before: '2026-06-01T00:00:00Z',
    }, 'c1');
    expect(searchMock).toHaveBeenCalledWith(
      'q', 'global', undefined, 'hybrid', 10, expect.any(Object),
      { after: '2026-01-01T00:00:00Z', before: '2026-06-01T00:00:00Z' }, false,
    );
  });

  it('still passes undefined for the filter when neither bound is given', async () => {
    await handleTool(ctx, 'search', { query: 'q' }, 'c1');
    expect(searchMock).toHaveBeenCalledWith(
      'q', 'global', undefined, 'hybrid', 10, expect.any(Object), undefined, false,
    );
  });

  it('returns up to limit in-window matches instead of starving on out-of-window top candidates (regression)', async () => {
    const matches = Array.from({ length: 5 }, (_, i) => makeResult({ id: `m${i}`, score: 0.9 - i * 0.01 }));
    searchMock.mockResolvedValue(matches);

    const result = await handleTool(ctx, 'search', {
      query: 'q', after: '2026-01-01T00:00:00Z', before: '2026-06-01T00:00:00Z', limit: 5,
    }, 'c1') as { results: SearchResult[] };

    expect(result.results).toHaveLength(5);
  });

  it('increments search_zero_after_filter when the defensive re-check removes an out-of-window result', async () => {
    searchMock.mockResolvedValue([
      makeResult({ id: 'too-old', created_at: '2025-01-01T00:00:00Z' }),
    ]);

    await handleTool(ctx, 'search', { query: 'q', after: '2026-01-01T00:00:00Z' }, 'c1');

    expect(ctx.metrics.incCounter).toHaveBeenCalledWith('search_zero_after_filter');
  });

  it('does not increment search_zero_after_filter when the store already returned only in-window results', async () => {
    searchMock.mockResolvedValue([
      makeResult({ id: 'in-window', created_at: '2026-03-01T00:00:00Z' }),
    ]);

    await handleTool(ctx, 'search', { query: 'q', after: '2026-01-01T00:00:00Z' }, 'c1');

    expect(ctx.metrics.incCounter).not.toHaveBeenCalledWith('search_zero_after_filter');
  });
});

// add-multi-candidate-extraction task 5.5: `handleRemember` already collapses
// a length-1 result array but returns the array unchanged otherwise
// (src/tools/index.ts:153) — exercised here with a live multi-candidate
// `pipeline.process` result instead of a single-candidate mock.
describe('remember tool multi-candidate response shape', () => {
  function makeCtx(process: ReturnType<typeof vi.fn>): ToolContext {
    return {
      config: {
        device: { id: 'local-device' },
        pipeline: { long_content_threshold_chars: 8000 },
      } as unknown as ToolContext['config'],
      storage: { sqlite: { countMemories: vi.fn(() => 3) } } as unknown as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: { process } as unknown as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  }

  it('returns an array (not collapsed) when pipeline.process resolves with more than one WriteResult', async () => {
    const process = vi.fn(async () => [
      { id: 'a', summary: 's1', type: 'semantic', operation: 'ADD', created_at: 'now' },
      { id: 'b', summary: 's2', type: 'semantic', operation: 'ADD', created_at: 'now' },
      { id: 'c', summary: 's3', type: 'semantic', operation: 'ADD', created_at: 'now' },
    ]);
    const ctx = makeCtx(process);

    const result = await handleTool(ctx, 'remember', { content: 'multi-fact content long enough to split' }, 'c1');

    expect(process).toHaveBeenCalledTimes(1);
    expect(Array.isArray(result)).toBe(true);
    expect(result as unknown[]).toHaveLength(3);
  });

  it('collapses to a single object when pipeline.process resolves with exactly one WriteResult', async () => {
    const process = vi.fn(async () => [
      { id: 'a', summary: 's1', type: 'semantic', operation: 'ADD', created_at: 'now' },
    ]);
    const ctx = makeCtx(process);

    const result = await handleTool(ctx, 'remember', { content: 'single fact content' }, 'c1') as { id: string };

    expect(Array.isArray(result)).toBe(false);
    expect(result.id).toBe('a');
  });
});

// add-long-content-chunking: `handleRemember` rejects content over
// `config.pipeline.long_content_threshold_chars` before ever calling
// `ctx.pipeline.process`, so nothing is embedded or written for over-threshold
// content.
describe('remember long-content threshold guard', () => {
  function makeCtx(process: ReturnType<typeof vi.fn>, thresholdChars: number): ToolContext {
    return {
      config: {
        device: { id: 'local-device' },
        pipeline: { long_content_threshold_chars: thresholdChars },
      } as unknown as ToolContext['config'],
      storage: { sqlite: { countMemories: vi.fn(() => 0) } } as unknown as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: { process } as unknown as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  }

  it('rejects content over the default 8000-char threshold with INVALID_INPUT and never calls the pipeline', async () => {
    const process = vi.fn(async () => [
      { id: 'a', summary: 's', type: 'semantic', operation: 'ADD', created_at: 'now' },
    ]);
    const ctx = makeCtx(process, 8000);
    const content = 'x'.repeat(8001);

    const result = await handleTool(ctx, 'remember', { content }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('import');
    expect(process).not.toHaveBeenCalled();
  });

  it('accepts content exactly at the threshold', async () => {
    const process = vi.fn(async () => [
      { id: 'a', summary: 's', type: 'semantic', operation: 'ADD', created_at: 'now' },
    ]);
    const ctx = makeCtx(process, 8000);
    const content = 'x'.repeat(8000);

    const result = await handleTool(ctx, 'remember', { content }, 'c1') as { id: string };

    expect(process).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('a');
  });

  it('accepts content comfortably under the threshold', async () => {
    const process = vi.fn(async () => [
      { id: 'a', summary: 's', type: 'semantic', operation: 'ADD', created_at: 'now' },
    ]);
    const ctx = makeCtx(process, 8000);

    const result = await handleTool(ctx, 'remember', { content: 'short content' }, 'c1') as { id: string };

    expect(process).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('a');
  });

  it('honors a custom pipeline.long_content_threshold_chars instead of a hardcoded constant', async () => {
    const process = vi.fn(async () => [
      { id: 'a', summary: 's', type: 'semantic', operation: 'ADD', created_at: 'now' },
    ]);
    const ctx = makeCtx(process, 100);
    const content = 'x'.repeat(101);

    const result = await handleTool(ctx, 'remember', { content }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INVALID_INPUT');
    expect(process).not.toHaveBeenCalled();
  });
});

describe('notifyResourceListChanged hook (complete-mcp-protocol-surface task 5.3)', () => {
  function createCtx(notify?: ReturnType<typeof vi.fn>): ToolContext {
    return {
      config: {} as ToolContext['config'],
      storage: {
        sqlite: {
          listCollections: vi.fn(() => []),
          createCollection: vi.fn(),
          flushIfDirty: vi.fn(),
          getCollection: vi.fn(() => ({ name: 'general' })),
          deleteCollection: vi.fn(() => true),
          countMemories: vi.fn(() => 0),
          listCategories: vi.fn(() => []),
          getCategory: vi.fn(() => ({ name: 'x', slot: 'custom', content: 'c', revision: 1 })),
          setCategory: vi.fn(() => ({ name: 'x', slot: 'custom', revision: 1 })),
          deleteCategory: vi.fn(() => true),
        },
        countMemoriesInCollection: vi.fn(() => 0),
        deleteCollectionData: vi.fn(async () => ({ deleted: 0, ids: [] })),
        logAudit: vi.fn(),
      } as unknown as StorageManager,
      embedding: { model: 'm', dimensions: 1 } as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as pino.Logger,
      notifyResourceListChanged: notify,
    };
  }

  it('fires exactly once on collections create', async () => {
    const notify = vi.fn();
    const ctx = createCtx(notify);

    await handleTool(ctx, 'collections', { action: 'create', namespace: 'global', name: 'new-col' }, 'c1');

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('fires exactly once on collections delete', async () => {
    const notify = vi.fn();
    const ctx = createCtx(notify);

    await handleTool(ctx, 'collections', { action: 'delete', namespace: 'global', name: 'general' }, 'c1');

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('fires exactly once on category set', async () => {
    const notify = vi.fn();
    const ctx = createCtx(notify);

    await handleTool(ctx, 'category', { action: 'set', name: 'x', content: 'hello' }, 'c1');

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('fires exactly once on category delete', async () => {
    const notify = vi.fn();
    const ctx = createCtx(notify);

    await handleTool(ctx, 'category', { action: 'delete', name: 'x' }, 'c1');

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not fire on collections list (read action)', async () => {
    const notify = vi.fn();
    const ctx = createCtx(notify);

    await handleTool(ctx, 'collections', { action: 'list', namespace: 'global' }, 'c1');

    expect(notify).not.toHaveBeenCalled();
  });

  it('does not fire on category list/get (read actions)', async () => {
    const notify = vi.fn();
    const ctx = createCtx(notify);

    await handleTool(ctx, 'category', { action: 'list' }, 'c1');
    await handleTool(ctx, 'category', { action: 'get', name: 'x' }, 'c1');

    expect(notify).not.toHaveBeenCalled();
  });

  it('does not fire when a collections delete fails (non-empty, no force)', async () => {
    const notify = vi.fn();
    const ctx = createCtx(notify);
    (ctx.storage.countMemoriesInCollection as ReturnType<typeof vi.fn>).mockReturnValue(3);

    const result = await handleTool(ctx, 'collections', { action: 'delete', namespace: 'global', name: 'general' }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('CONFLICT');
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not fire when a category delete fails (not found)', async () => {
    const notify = vi.fn();
    const ctx = createCtx(notify);
    (ctx.storage.sqlite.deleteCategory as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await handleTool(ctx, 'category', { action: 'delete', name: 'x' }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('NOT_FOUND');
    expect(notify).not.toHaveBeenCalled();
  });

  it('is a no-op when the hook is absent (REST path)', async () => {
    const ctx = createCtx(undefined);

    const result = await handleTool(ctx, 'collections', { action: 'create', namespace: 'global', name: 'new-col' }, 'c1');

    expect((result as { ok: boolean }).ok).toBe(true);
  });
});

describe('relate tool (add-memory-links)', () => {
  const FROM = '550e8400-e29b-41d4-a716-446655440020';
  const TO = '550e8400-e29b-41d4-a716-446655440021';
  type RelateStorage = StorageManager & {
    sqlite: {
      getMemoryById: ReturnType<typeof vi.fn>;
      addMemoryLink: ReturnType<typeof vi.fn>;
      removeMemoryLink: ReturnType<typeof vi.fn>;
      listMemoryLinks: ReturnType<typeof vi.fn>;
      flushIfDirty: ReturnType<typeof vi.fn>;
    };
  };
  let ctx: ToolContext;
  let storage: RelateStorage;

  beforeEach(() => {
    storage = {
      sqlite: {
        getMemoryById: vi.fn(() => null),
        addMemoryLink: vi.fn(),
        removeMemoryLink: vi.fn(() => false),
        listMemoryLinks: vi.fn(() => []),
        flushIfDirty: vi.fn(),
      },
    } as unknown as RelateStorage;

    ctx = {
      config: {} as ToolContext['config'],
      storage,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  it('add creates an edge and returns the storage record with created: true', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      (id === FROM || id === TO ? { id, namespace: 'global' } : null));
    (storage.sqlite.addMemoryLink as ReturnType<typeof vi.fn>).mockReturnValue({
      record: { id: 1, namespace: 'global', from_id: FROM, to_id: TO, relation: 'refines', created_at: 'now', created_by: 'c1' },
      created: true,
    });

    const result = await handleTool(ctx, 'relate', {
      action: 'add', from_id: FROM, to_id: TO, relation: 'refines',
    }, 'c1') as { id: number; created: boolean; from_id: string; to_id: string; relation: string };

    expect(storage.sqlite.addMemoryLink).toHaveBeenCalledWith('global', FROM, TO, 'refines', 'c1');
    expect(result.created).toBe(true);
    expect(result.from_id).toBe(FROM);
    expect(result.to_id).toBe(TO);
    expect(result.relation).toBe('refines');
  });

  it('add is idempotent: re-adding an existing edge returns created: false', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      (id === FROM || id === TO ? { id, namespace: 'global' } : null));
    (storage.sqlite.addMemoryLink as ReturnType<typeof vi.fn>).mockReturnValue({
      record: { id: 1, namespace: 'global', from_id: FROM, to_id: TO, relation: 'refines', created_at: 'now', created_by: null },
      created: false,
    });

    const result = await handleTool(ctx, 'relate', {
      action: 'add', from_id: FROM, to_id: TO, relation: 'refines',
    }, 'c1') as { created: boolean };

    expect(result.created).toBe(false);
  });

  it('add rejects a self-link with INVALID_INPUT', async () => {
    const result = await handleTool(ctx, 'relate', {
      action: 'add', from_id: FROM, to_id: FROM, relation: 'refines',
    }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INVALID_INPUT');
    expect(storage.sqlite.addMemoryLink).not.toHaveBeenCalled();
  });

  it('add rejects a cross-namespace link with INVALID_INPUT', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === FROM) return { id, namespace: 'global' };
      if (id === TO) return { id, namespace: 'other' };
      return null;
    });

    const result = await handleTool(ctx, 'relate', {
      action: 'add', from_id: FROM, to_id: TO, relation: 'refines',
    }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INVALID_INPUT');
    expect(storage.sqlite.addMemoryLink).not.toHaveBeenCalled();
  });

  it('add is NOT_FOUND when from_id does not exist', async () => {
    const result = await handleTool(ctx, 'relate', {
      action: 'add', from_id: FROM, to_id: TO, relation: 'refines',
    }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('add is NOT_FOUND when to_id does not exist', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      (id === FROM ? { id, namespace: 'global' } : null));

    const result = await handleTool(ctx, 'relate', {
      action: 'add', from_id: FROM, to_id: TO, relation: 'refines',
    }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('remove deletes an edge and returns removed: true', async () => {
    (storage.sqlite.removeMemoryLink as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = await handleTool(ctx, 'relate', {
      action: 'remove', from_id: FROM, to_id: TO, relation: 'refines',
    }, 'c1') as { removed: boolean };

    expect(storage.sqlite.removeMemoryLink).toHaveBeenCalledWith(FROM, TO, 'refines');
    expect(result.removed).toBe(true);
  });

  it('remove on a non-existent edge is NOT_FOUND', async () => {
    const result = await handleTool(ctx, 'relate', {
      action: 'remove', from_id: FROM, to_id: TO, relation: 'refines',
    }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('list is NOT_FOUND for a missing memory id', async () => {
    const result = await handleTool(ctx, 'relate', { action: 'list', id: FROM }, 'c1') as BrainErrorEnvelope;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('list returns both-direction edges by default', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockReturnValue({ id: FROM, namespace: 'global' });
    (storage.sqlite.listMemoryLinks as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 1, namespace: 'global', from_id: FROM, to_id: TO, relation: 'refines', direction: 'outgoing', created_at: 'a', created_by: null },
      { id: 2, namespace: 'global', from_id: TO, to_id: FROM, relation: 'contradicts', direction: 'incoming', created_at: 'b', created_by: null },
    ]);

    const result = await handleTool(ctx, 'relate', { action: 'list', id: FROM }, 'c1') as { links: Array<{ direction: string }> };

    expect(result.links).toHaveLength(2);
  });

  it('list respects a direction filter', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockReturnValue({ id: FROM, namespace: 'global' });
    (storage.sqlite.listMemoryLinks as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 1, namespace: 'global', from_id: FROM, to_id: TO, relation: 'refines', direction: 'outgoing', created_at: 'a', created_by: null },
      { id: 2, namespace: 'global', from_id: TO, to_id: FROM, relation: 'contradicts', direction: 'incoming', created_at: 'b', created_by: null },
    ]);

    const result = await handleTool(ctx, 'relate', { action: 'list', id: FROM, direction: 'from' }, 'c1') as { links: Array<{ direction: string }> };

    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.direction).toBe('outgoing');
  });

  it('list respects a relation filter', async () => {
    (storage.sqlite.getMemoryById as ReturnType<typeof vi.fn>).mockReturnValue({ id: FROM, namespace: 'global' });
    (storage.sqlite.listMemoryLinks as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 1, namespace: 'global', from_id: FROM, to_id: TO, relation: 'refines', direction: 'outgoing', created_at: 'a', created_by: null },
    ]);

    await handleTool(ctx, 'relate', { action: 'list', id: FROM, relation: 'refines' }, 'c1');

    expect(storage.sqlite.listMemoryLinks).toHaveBeenCalledWith(FROM, { relation: 'refines' });
  });
});

describe('handleRecall follow_links (add-memory-links)', () => {
  let ctx: ToolContext;
  let searchMock: ReturnType<typeof vi.fn>;
  let listMemoryLinksMock: ReturnType<typeof vi.fn>;
  let getMemoryByIdMock: ReturnType<typeof vi.fn>;

  function makeResult(overrides: Partial<SearchResult> & { id: string }): SearchResult {
    return {
      content: 'content',
      summary: 'summary',
      type: 'semantic',
      tags: [],
      score: 0.9,
      semantic_score: 0.9,
      retention_tier: 'T2',
      expires_at: null,
      expiring_soon: false,
      device_id: null,
      created_at: '2026-01-01T00:00:00Z',
      last_accessed: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  function makeMemory(id: string) {
    return {
      id, namespace: 'global', collection: 'general', content: 'linked content', summary: 'linked summary',
      type: 'semantic' as const, category: null, tags: [] as string[], source: 'cli' as const, checksum: 'x',
      importance: 0.5, retention_tier: 'T2' as const, expires_at: null, decay_eligible: true, review_due: null,
      access_count: 0, last_operation: 'ADD' as const, merged_from: null, archived: false, vector_synced: true,
      device_id: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      last_accessed: '2026-01-01T00:00:00Z',
    };
  }

  beforeEach(() => {
    searchMock = vi.fn(async () => [] as SearchResult[]);
    listMemoryLinksMock = vi.fn(() => []);
    getMemoryByIdMock = vi.fn(() => null);
    ctx = {
      config: { search: { mmr: { enabled: false }, rerank: { enabled: false, candidate_pool: 20 } } } as unknown as ToolContext['config'],
      storage: {
        sqlite: { listMemoryLinks: listMemoryLinksMock, getMemoryById: getMemoryByIdMock },
      } as unknown as StorageManager,
      embedding: {} as EmbeddingProvider,
      pipeline: {} as WritePipeline,
      search: { search: searchMock } as unknown as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  it('default (follow_links omitted) leaves recall output unchanged: no linked_from field, no listMemoryLinks calls', async () => {
    searchMock.mockResolvedValue([makeResult({ id: 'base-1' })]);

    const result = await handleTool(ctx, 'recall', { query: 'q', limit: 5 }, 'c1') as { results: SearchResult[] };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.linked_from).toBeUndefined();
    expect(listMemoryLinksMock).not.toHaveBeenCalled();
  });

  it('follow_links: true appends one-hop neighbors marked with linked_from/link_relation/link_direction', async () => {
    searchMock.mockResolvedValue([makeResult({ id: 'base-1' })]);
    listMemoryLinksMock.mockImplementation((id: string) => (id === 'base-1' ? [
      { id: 1, namespace: 'global', from_id: 'base-1', to_id: 'neighbor-1', relation: 'refines', created_at: 'a', created_by: null, direction: 'outgoing' },
    ] : []));
    getMemoryByIdMock.mockImplementation((id: string) => (id === 'neighbor-1' ? makeMemory('neighbor-1') : null));

    const result = await handleTool(ctx, 'recall', { query: 'q', limit: 5, follow_links: true }, 'c1') as { results: SearchResult[] };

    expect(result.results).toHaveLength(2);
    const neighbor = result.results[1]!;
    expect(neighbor.id).toBe('neighbor-1');
    expect(neighbor.linked_from).toBe('base-1');
    expect(neighbor.link_relation).toBe('refines');
    expect(neighbor.link_direction).toBe('outgoing');
    expect(neighbor.score).toBe(0);
  });

  it('a neighbor reachable from two base results appears once', async () => {
    searchMock.mockResolvedValue([makeResult({ id: 'base-1' }), makeResult({ id: 'base-2' })]);
    listMemoryLinksMock.mockImplementation((id: string) => {
      if (id === 'base-1') {
        return [{ id: 1, namespace: 'global', from_id: 'base-1', to_id: 'shared-neighbor', relation: 'refines', created_at: 'a', created_by: null, direction: 'outgoing' }];
      }
      if (id === 'base-2') {
        return [{ id: 2, namespace: 'global', from_id: 'base-2', to_id: 'shared-neighbor', relation: 'contradicts', created_at: 'b', created_by: null, direction: 'outgoing' }];
      }
      return [];
    });
    getMemoryByIdMock.mockImplementation((id: string) => (id === 'shared-neighbor' ? makeMemory('shared-neighbor') : null));

    const result = await handleTool(ctx, 'recall', { query: 'q', limit: 5, follow_links: true }, 'c1') as { results: SearchResult[] };

    expect(result.results).toHaveLength(3);
    expect(result.results.filter(r => r.id === 'shared-neighbor')).toHaveLength(1);
  });

  it('total appended neighbors respect the limit cap', async () => {
    searchMock.mockResolvedValue([makeResult({ id: 'base-1' })]);
    listMemoryLinksMock.mockImplementation((id: string) => (id === 'base-1'
      ? Array.from({ length: 5 }, (_, i) => ({
        id: i, namespace: 'global', from_id: 'base-1', to_id: `neighbor-${i}`, relation: 'refines' as const, created_at: 'a', created_by: null, direction: 'outgoing' as const,
      }))
      : []));
    getMemoryByIdMock.mockImplementation((id: string) => (id.startsWith('neighbor-') ? makeMemory(id) : null));

    const result = await handleTool(ctx, 'recall', { query: 'q', limit: 2, follow_links: true }, 'c1') as { results: SearchResult[] };

    // 1 base result + at most `limit` (2) appended neighbors.
    expect(result.results).toHaveLength(3);
    expect(result.results.filter(r => r.linked_from)).toHaveLength(2);
  });

  it('an archived neighbor (absent from the default non-archived-only lookup) is skipped', async () => {
    searchMock.mockResolvedValue([makeResult({ id: 'base-1' })]);
    listMemoryLinksMock.mockImplementation((id: string) => (id === 'base-1' ? [
      { id: 1, namespace: 'global', from_id: 'base-1', to_id: 'archived-neighbor', relation: 'refines', created_at: 'a', created_by: null, direction: 'outgoing' },
    ] : []));
    getMemoryByIdMock.mockReturnValue(null);

    const result = await handleTool(ctx, 'recall', { query: 'q', limit: 5, follow_links: true }, 'c1') as { results: SearchResult[] };

    expect(result.results).toHaveLength(1);
    expect(result.results.every(r => !r.linked_from)).toBe(true);
  });
});
