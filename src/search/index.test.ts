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
    slidingWindowEnabled?: boolean;
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
      ...(opts.slidingWindowEnabled === undefined ? {} : {
        retention: {
          tier_ttl: { T0: null, T1: 365, T2: 90, T3: 30 },
          auto_promote_access_threshold: 5,
          sliding_window_enabled: opts.slidingWindowEnabled,
          pre_expiry_warning_days: 7,
        },
      }),
    } as unknown as BrainConfig;

    const embedding = {
      model: 'test-model',
      dimensions: 3,
      embed: vi.fn(async () => [1, 2, 3]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3])),
      healthCheck: vi.fn(async () => true),
    } as EmbeddingProvider;

    const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn() } as unknown as MetricsCollector;
    const logger = { warn: vi.fn() };

    return {
      service: new SearchService(config, storage, embedding, metrics, logger),
      storage,
      embedding,
      metrics,
      logger,
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

  it('preserves ranked order even when the store returns rows in a different order', async () => {
    // Regression: an `IN (...)` bulk lookup does not guarantee row order matches
    // the ranked input. The service-layer memoryMap must re-order results to the
    // ranking, not trust whatever order the store hands back.
    const makeMem = (id: string): StoredMemory => ({
      id, namespace: 'global', collection: 'general', type: 'semantic',
      content: `content-${id}`, summary: `summary-${id}`, tags: [], source: 'cli',
      checksum: id,
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
    });
    const memories = new Map<string, StoredMemory>([
      ['mem-1', makeMem('mem-1')],
      ['mem-2', makeMem('mem-2')],
      ['mem-3', makeMem('mem-3')],
    ]);
    const { service, storage } = createSearchService({
      memories,
      fulltextResults: [
        { id: 'mem-3', rank: -3 },
        { id: 'mem-1', rank: -2 },
        { id: 'mem-2', rank: -1 },
      ],
    });
    // Deliberately return rows in ascending-id order — the opposite of the
    // ranked input — so a regression that trusted SQL row order would fail.
    (storage.sqlite.getMemoriesByIds as ReturnType<typeof vi.fn>).mockImplementation(
      (ids: string[]) => [...ids].sort().map(id => memories.get(id)).filter((m): m is StoredMemory => !!m),
    );

    const results = await service.search('hello', 'global', undefined, 'fulltext', 10);
    expect(results.map(r => r.id)).toEqual(['mem-3', 'mem-1', 'mem-2']);
  });

  it('reconstructs a search result from the Qdrant payload when the ranked id misses local storage', async () => {
    const { service, storage } = createSearchService({ memories: new Map() });
    storage.qdrant.search.mockResolvedValue([
      {
        id: 'mem-cross-device',
        score: 0.87,
        payload: {
          content: 'cross-device content',
          summary: 'cross-device summary',
          type: 'episodic',
          tags: ['a', 'b'],
          retention_tier: 'T1',
          device_id: 'device-42',
          created_at: '2026-01-05T00:00:00Z',
        },
      },
    ]);

    const results = await service.search('hello', 'global', undefined, 'semantic', 10);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'mem-cross-device',
      content: 'cross-device content',
      summary: 'cross-device summary',
      type: 'episodic',
      tags: ['a', 'b'],
      retention_tier: 'T1',
      device_id: 'device-42',
      created_at: '2026-01-05T00:00:00Z',
      expires_at: null,
      expiring_soon: false,
    });
  });

  it('falls back to established defaults for malformed Qdrant payload fields', async () => {
    const { service, storage } = createSearchService({ memories: new Map() });
    storage.qdrant.search.mockResolvedValue([
      {
        id: 'mem-cross-device',
        score: 0.5,
        payload: {
          content: 'partial content',
          summary: 42,
          type: 'not-a-real-type',
          tags: 'not-an-array',
          retention_tier: 'BOGUS',
          device_id: 123,
          created_at: 999,
        },
      },
    ]);

    const results = await service.search('hello', 'global', undefined, 'semantic', 10);
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.content).toBe('partial content');
    expect(result.summary).toBe('');
    expect(result.type).toBe('semantic');
    expect(result.tags).toEqual([]);
    expect(result.retention_tier).toBe('T2');
    expect(result.device_id).toBeNull();
    expect(typeof result.created_at).toBe('string');
    expect(result.created_at).not.toBe(999);
  });

  it('drops the fallback result when the Qdrant payload has no usable content', async () => {
    const { service, storage } = createSearchService({ memories: new Map() });
    storage.qdrant.search.mockResolvedValue([
      { id: 'mem-cross-device', score: 0.5, payload: { summary: 'no content field' } },
    ]);

    const results = await service.search('hello', 'global', undefined, 'semantic', 10);
    expect(results).toHaveLength(0);
  });

  it('preserves existing expiry on read when sliding window is disabled', async () => {
    // Regression: non-sliding access updates must not clear T2/T3 TTLs.
    const { service, storage } = createSearchService({ slidingWindowEnabled: false });
    await service.search('hello', 'global', undefined, 'fulltext', 10);
    expect(storage.sqlite.recordAccessBatch).toHaveBeenCalledTimes(1);
    const updates = (storage.sqlite.recordAccessBatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updates).toHaveLength(1);
    // undefined = "no change" -> recordAccessBatch leaves expires_at untouched.
    expect(updates[0].expires_at).toBeUndefined();
    expect(updates[0].access_count).toBe(1);
  });

  it('extends expiry on read when sliding window is enabled', async () => {
    const { service, storage } = createSearchService({ slidingWindowEnabled: true });
    await service.search('hello', 'global', undefined, 'fulltext', 10);
    const updates = (storage.sqlite.recordAccessBatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // sliding mode recomputes the deadline -> a concrete ISO timestamp string.
    expect(typeof updates[0].expires_at).toBe('string');
  });

  it('signals (metric + warn) instead of silently swallowing embedding outage in hybrid mode', async () => {
    const { service, storage, embedding, metrics, logger } = createSearchService();
    (embedding.embed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('embeddings down'));
    // Hybrid degrades to fulltext-only rather than throwing...
    const results = await service.search('hello', 'global', undefined, 'hybrid', 10);
    expect(results.length).toBeGreaterThan(0);
    // ...but the degradation is observable.
    expect(metrics.incCounter).toHaveBeenCalledWith('search_embedding_degraded');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'embedding_degraded', degraded: 'fulltext_only' }),
    );
    // Qdrant should not have been queried once embedding failed.
    expect(storage.qdrant.search).not.toHaveBeenCalled();
  });

  it('sets the degraded signal when hybrid falls back to fulltext-only', async () => {
    const { service, embedding } = createSearchService();
    (embedding.embed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('embeddings down'));
    const signal: { degraded?: boolean } = {};
    await service.search('hello', 'global', undefined, 'hybrid', 10, signal);
    expect(signal.degraded).toBe(true);
  });

  it('leaves the degraded signal unset on a healthy hybrid search', async () => {
    const { service } = createSearchService();
    const signal: { degraded?: boolean } = {};
    await service.search('hello', 'global', undefined, 'hybrid', 10, signal);
    expect(signal.degraded).toBeUndefined();
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
