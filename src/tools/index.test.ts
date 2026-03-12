import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTool, type ToolContext } from './index.js';

describe('collections delete semantics', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = {
      config: {} as any,
      storage: {
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
      } as any,
      embedding: { model: 'm', dimensions: 1 } as any,
      pipeline: {} as any,
      search: {} as any,
      backup: {} as any,
      health: {} as any,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    };
  });

  it('rejects deleting non-empty collection without force', async () => {
    const result = await handleTool(ctx, 'collections', { action: 'delete', name: 'general' }, 'c1') as any;
    expect(result.error.code).toBe('CONFLICT');
    expect((ctx.storage as any).deleteCollectionData).not.toHaveBeenCalled();
    expect((ctx.storage as any).sqlite.deleteCollection).not.toHaveBeenCalled();
  });

  it('force deletes collection and returns deleted memory count', async () => {
    const result = await handleTool(ctx, 'collections', {
      action: 'delete',
      namespace: 'global',
      name: 'general',
      force: true,
    }, 'c1') as any;

    expect(result.ok).toBe(true);
    expect(result.deleted_memory_count).toBe(3);
    expect((ctx.storage as any).deleteCollectionData).toHaveBeenCalledWith('global', 'general');
    expect((ctx.storage as any).sqlite.deleteCollection).toHaveBeenCalledWith('global', 'general');
    expect((ctx.storage as any).logAudit).toHaveBeenCalledTimes(3);
    expect((ctx.metrics as any).setGauge).toHaveBeenCalled();
  });

  it('deletes empty collection without force', async () => {
    (ctx.storage as any).countMemoriesInCollection = vi.fn(() => 0);

    const result = await handleTool(ctx, 'collections', {
      action: 'delete',
      namespace: 'global',
      name: 'general',
    }, 'c1') as any;

    expect(result.ok).toBe(true);
    expect(result.deleted_memory_count).toBe(0);
    expect((ctx.storage as any).deleteCollectionData).not.toHaveBeenCalled();
    expect((ctx.storage as any).sqlite.deleteCollection).toHaveBeenCalledWith('global', 'general');
  });

  it('surfaces collection cleanup failures instead of silently succeeding', async () => {
    (ctx.storage as any).deleteCollectionData = vi.fn(async () => {
      throw new Error('qdrant unavailable');
    });

    const result = await handleTool(ctx, 'collections', {
      action: 'delete',
      namespace: 'global',
      name: 'general',
      force: true,
    }, 'c1') as any;

    expect(result.error.code).toBe('INTERNAL');
    expect((ctx.storage as any).sqlite.deleteCollection).not.toHaveBeenCalled();
  });
});
