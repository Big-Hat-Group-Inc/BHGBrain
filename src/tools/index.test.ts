import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTool, type ToolContext } from './index.js';
import type { BrainErrorEnvelope } from '../errors/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { WritePipeline } from '../pipeline/index.js';
import type { SearchService } from '../search/index.js';
import type { BackupService } from '../backup/index.js';
import type { HealthService } from '../health/index.js';
import type { MetricsCollector } from '../health/metrics.js';
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
    expect(storage.deleteCollectionData).toHaveBeenCalledWith('global', 'general');
    expect(storage.sqlite.deleteCollection).toHaveBeenCalledWith('global', 'general');
    expect(storage.logAudit).toHaveBeenCalledTimes(3);
    expect(ctx.metrics.setGauge).toHaveBeenCalled();
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
