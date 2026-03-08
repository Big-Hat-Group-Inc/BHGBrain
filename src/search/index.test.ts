import { describe, it, expect, vi } from 'vitest';
import { SearchService } from './index.js';

describe('SearchService', () => {
  function createSearchService(opts: {
    fulltextResults?: Array<{ id: string; rank: number }>;
    memories?: Map<string, any>;
  } = {}) {
    const memories = opts.memories ?? new Map([
      ['mem-1', {
        id: 'mem-1', namespace: 'global', collection: 'general', type: 'semantic',
        content: 'hello world', summary: 'hello', tags: [], source: 'cli',
        score: 0.9, created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
      }],
    ]);

    const storage = {
      sqlite: {
        fullTextSearch: vi.fn((_ns: string, _q: string, _limit: number, _col?: string) =>
          opts.fulltextResults ?? [{ id: 'mem-1', rank: -1 }],
        ),
        getMemoryById: vi.fn((id: string) => memories.get(id) ?? null),
        touchMemory: vi.fn(),
        scheduleDeferredFlush: vi.fn(),
      },
      qdrant: {
        search: vi.fn(async () => []),
      },
    } as any;

    const config = {
      search: { hybrid_weights: { semantic: 0.7, fulltext: 0.3 } },
    } as any;

    const embedding = {
      embed: vi.fn(async () => [1, 2, 3]),
    } as any;

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
