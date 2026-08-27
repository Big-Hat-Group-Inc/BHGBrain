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
    expect(storage.deleteCollectionData).toHaveBeenCalledWith('global', 'general', { logger: ctx.logger });
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
