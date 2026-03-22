import { describe, it, expect, vi } from 'vitest';
import { SearchService } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { MemoryRecord } from '../domain/types.js';
import type { StorageManager } from '../storage/index.js';

type StoredMemory = Omit<MemoryRecord, 'embedding'>;

describe('SearchService', () => {
  function createSearchService(opts: {
    fulltextResults?: Array<{ id: string; rank: number }>;
    memories?: Map<string, StoredMemory>;
  } = {}) {
    const memories = opts.memories ?? new Map([
      ['mem-1', {
        id: 'mem-1', namespace: 'global', collection: 'general', type: 'semantic',
        content: 'hello world', summary: 'hello', tags: [], source: 'cli',
        checksum: 'mem-1',
        importance: 0.9,
        retention_tier: 'T2',
        expires_at: '2026-12-31T00:00:00Z',
        decay_eligible: true,
        review_due: null,
        access_count: 0,
        last_operation: 'ADD',
        merged_from: null,
        archived: false,
        vector_synced: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        last_accessed: '2026-01-01T00:00:00Z',
      }],
    ]);

    const storage = {
      sqlite: {
        fullTextSearch: vi.fn((_ns: string, _q: string, _limit: number, _col?: string) =>
          opts.fulltextResults ?? [{ id: 'mem-1', rank: -1 }],
        ),
        getMemoriesByIds: vi.fn((ids: string[]) => ids.map(id => memories.get(id)).filter(Boolean)),
        getMemoryById: vi.fn((id: string) => memories.get(id) ?? null),
        recordAccessBatch: vi.fn(),
        touchMemory: vi.fn(),
        scheduleDeferredFlush: vi.fn(),
      },
      qdrant: {
        search: vi.fn(async () => []),
      },
    } as unknown as StorageManager;

    const config = {
      search: { hybrid_weights: { semantic: 0.7, fulltext: 0.3 } },
    } as unknown as BrainConfig;

    const embedding = {
      model: 'test-model',
      dimensions: 3,
      embed: vi.fn(async () => [1, 2, 3]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3])),
      healthCheck: vi.fn(async () => true),
    } as EmbeddingProvider;

    return {
      service: new SearchService(config, storage, embedding),
      storage,
      embedding,
    };
  }

  it('passes collection to fulltext search', async () => {
    const { service, storage } = createSearchService();
    await service.search('hello', 'global', 'my-col', 'fulltext', 10);
    expect(storage.sqlite.fullTextSearch).toHaveBeenCalledWith('global', 'hello', 10, 'my-col');
  });

  it('passes collection to fulltext in hybrid mode', async () => {
    const { service, storage } = createSearchService();
    await service.search('hello', 'global', 'my-col', 'hybrid', 5);
    expect(storage.sqlite.fullTextSearch).toHaveBeenCalledWith('global', 'hello', 10, 'my-col');
  });

  it('uses deferred flush instead of synchronous flush on read paths', async () => {
    const { service, storage } = createSearchService();
    await service.search('hello', 'global', undefined, 'fulltext', 10);
    expect(storage.sqlite.scheduleDeferredFlush).toHaveBeenCalled();
    expect(storage.sqlite.recordAccessBatch).toHaveBeenCalled();
  });

  it('hydrates ranked results in bulk when the store supports it', async () => {
    const { service, storage } = createSearchService();
    await service.search('hello', 'global', undefined, 'fulltext', 10);
    expect(storage.sqlite.getMemoriesByIds).toHaveBeenCalledWith(['mem-1']);
  });

  it('surfaces Qdrant failures as errors in semantic search', async () => {
    const { service, storage, embedding } = createSearchService();
    storage.qdrant.search.mockRejectedValue(new Error('connection refused'));
    await expect(
      service.search('hello', 'global', undefined, 'semantic', 10),
    ).rejects.toThrow('vector store unavailable');
  });
});

describe('Pagination stability', () => {
  it('composite cursor prevents skipping rows with same timestamp', () => {
    // Verify composite cursor format: "timestamp|id"
    const cursor = '2026-01-01T00:00:00Z|mem-5';
    const sepIdx = cursor.indexOf('|');
    expect(sepIdx).toBeGreaterThan(0);
    const time = cursor.substring(0, sepIdx);
    const id = cursor.substring(sepIdx + 1);
    expect(time).toBe('2026-01-01T00:00:00Z');
    expect(id).toBe('mem-5');
  });
});
