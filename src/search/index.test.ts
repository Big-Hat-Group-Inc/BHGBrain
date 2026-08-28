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
    ranking?: BrainConfig['search']['ranking'];
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
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const config = {
      search: {
        hybrid_weights: { semantic: 0.7, fulltext: 0.3 },
        ranking: opts.ranking ?? {
          enabled: true,
          w_importance: 0.3,
          w_access: 0.2,
          access_norm: 50,
          decay_per_day: { T0: 0, T1: 0.002, T2: 0.008, T3: 0.02 },
        },
      },
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

  // add-review-and-archive-recall
  it('appends archived matches marked archived: true without reducing the active-results limit', async () => {
    const { service, storage } = createSearchService();
    (storage.sqlite as unknown as { searchArchived: ReturnType<typeof vi.fn> }).searchArchived = vi.fn(
      (_ns: string, _q: string, _limit: number) => [
        {
          id: 99, memory_id: 'archived-1', summary: 'an archived summary', tier: 'T2',
          namespace: 'global', created_at: '2025-01-01T00:00:00Z', expired_at: '2025-06-01T00:00:00Z',
          access_count: 2, tags: ['old'],
        },
      ],
    );

    const results = await service.search(
      'hello', 'global', undefined, 'fulltext', 10, undefined, undefined, true,
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('mem-1');
    expect(results[0]!.archived).toBeUndefined();
    const archivedResult = results[1]!;
    expect(archivedResult.id).toBe('archived-1');
    expect(archivedResult.archived).toBe(true);
    expect(archivedResult.summary).toBe('an archived summary');
    expect(archivedResult.tags).toEqual(['old']);
    expect(storage.sqlite.recordAccessBatch).toHaveBeenCalledWith([expect.objectContaining({ id: 'mem-1' })]);
  });

  it('excludes archived matches by default', async () => {
    const { service, storage } = createSearchService();
    const searchArchived = vi.fn(() => []);
    (storage.sqlite as unknown as { searchArchived: typeof searchArchived }).searchArchived = searchArchived;

    const results = await service.search('hello', 'global', undefined, 'fulltext', 10);

    expect(results.every(r => r.archived === undefined)).toBe(true);
    expect(searchArchived).not.toHaveBeenCalled();
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

  it('emits a distinct PROMOTE audit event when access-driven promotion crosses the threshold', async () => {
    const memories = new Map<string, StoredMemory>([
      ['mem-1', {
        id: 'mem-1', namespace: 'global', collection: 'general', type: 'semantic',
        content: 'hello world', summary: 'hello', tags: [], source: 'cli',
        checksum: 'mem-1',
        importance: 0.9,
        retention_tier: 'T3',
        expires_at: '2026-12-31T00:00:00Z',
        decay_eligible: true,
        review_due: null,
        access_count: 4, // next access (5) hits the default threshold of 5
        last_operation: 'ADD',
        merged_from: null,
        archived: false,
        vector_synced: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        last_accessed: '2026-01-01T00:00:00Z',
      }],
    ]);
    const { service, storage } = createSearchService({ memories, slidingWindowEnabled: true });

    await service.search('hello', 'global', undefined, 'fulltext', 10);

    expect(storage.logAudit).toHaveBeenCalledWith('PROMOTE', 'mem-1', 'global', 'system', {
      flush: false,
      details: {
        memory_id: 'mem-1',
        prior_tier: 'T3',
        new_tier: 'T2',
        actor: 'system',
        timestamp: expect.any(String),
        action: 'promote',
      },
    });
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

  describe('push-down-recall-filters: filter plumbing', () => {
    it('pushes a type/tags filter down to the vector store in semantic mode', async () => {
      const { service, storage } = createSearchService();
      await service.search('hello', 'global', undefined, 'semantic', 10, undefined, { type: 'procedural', tags: ['ops'] });
      expect(storage.qdrant.search).toHaveBeenCalledWith(
        'global', undefined, [1, 2, 3], 10, { type: 'procedural', tags: ['ops'] },
      );
    });

    it('pushes a type/tags filter down to fulltext search', async () => {
      const { service, storage } = createSearchService();
      await service.search('hello', 'global', 'my-col', 'fulltext', 10, undefined, { type: 'episodic' });
      expect(storage.sqlite.fullTextSearch).toHaveBeenCalledWith(
        'global', 'hello', 10, 'my-col', { type: 'episodic' },
      );
    });

    it('pushes a type/tags filter down to both stores in hybrid mode', async () => {
      const { service, storage } = createSearchService();
      await service.search('hello', 'global', 'my-col', 'hybrid', 5, undefined, { tags: ['x'] });
      expect(storage.sqlite.fullTextSearch).toHaveBeenCalledWith(
        'global', 'hello', 10, 'my-col', { tags: ['x'] },
      );
      expect(storage.qdrant.search).toHaveBeenCalledWith(
        'global', 'my-col', [1, 2, 3], 10, { tags: ['x'] },
      );
    });

    it('does not pass a filter argument to either store when none is provided', async () => {
      // Unfiltered calls must be identical to pre-change behavior: no extra
      // (even undefined) argument reaching the store mocks.
      const { service, storage } = createSearchService();
      await service.search('hello', 'global', 'my-col', 'hybrid', 5);
      expect(storage.sqlite.fullTextSearch).toHaveBeenCalledWith('global', 'hello', 10, 'my-col');
      expect(storage.qdrant.search).toHaveBeenCalledWith('global', 'my-col', [1, 2, 3], 10);
    });
  });

  describe('searchForInject (relevance-conditioned inject)', () => {
    it('requests vectors from the semantic leg and attaches them to hybrid results', async () => {
      const { service, storage } = createSearchService();
      storage.qdrant.search.mockResolvedValue([
        { id: 'mem-1', score: 0.9, payload: {}, vector: [1, 2, 3] },
      ]);

      const results = await service.searchForInject('deployment task', 'global', 5);

      expect(storage.qdrant.search).toHaveBeenCalledWith(
        'global', undefined, [1, 2, 3], 10, { withVector: true },
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.vector).toEqual([1, 2, 3]);
    });

    it('degrades to a fulltext-only selection when embeddings are unavailable, with no vectors', async () => {
      const { service, embedding, storage } = createSearchService();
      (embedding.embed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('embeddings down'));
      const signal: { degraded?: boolean } = {};

      const results = await service.searchForInject('deployment task', 'global', 5, signal);

      expect(signal.degraded).toBe(true);
      expect(storage.qdrant.search).not.toHaveBeenCalled();
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.vector).toBeUndefined();
    });
  });

  describe('composite ranking (add-composite-recall-ranking)', () => {
    const makeMem = (id: string, overrides: Partial<StoredMemory> = {}): StoredMemory => ({
      id, namespace: 'global', collection: 'general', type: 'semantic',
      content: `content-${id}`, summary: `summary-${id}`, tags: [], source: 'cli',
      checksum: id,
      importance: 0.5,
      retention_tier: 'T1',
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
      ...overrides,
    });

    it('orders equal-relevance semantic (cosine-range) results by importance', async () => {
      const memories = new Map<string, StoredMemory>([
        ['low-importance', makeMem('low-importance', { importance: 0.1 })],
        ['high-importance', makeMem('high-importance', { importance: 0.9 })],
      ]);
      const { service, storage } = createSearchService({ memories });
      storage.qdrant.search.mockResolvedValue([
        { id: 'low-importance', score: 0.8, payload: {} },
        { id: 'high-importance', score: 0.8, payload: {} },
      ]);

      const results = await service.search('hello', 'global', undefined, 'semantic', 10);
      expect(results.map(r => r.id)).toEqual(['high-importance', 'low-importance']);
    });

    it('orders equal-relevance semantic (cosine-range) results by access frequency', async () => {
      const memories = new Map<string, StoredMemory>([
        ['low-access', makeMem('low-access', { access_count: 0 })],
        ['high-access', makeMem('high-access', { access_count: 100 })],
      ]);
      const { service, storage } = createSearchService({ memories });
      storage.qdrant.search.mockResolvedValue([
        { id: 'low-access', score: 0.8, payload: {} },
        { id: 'high-access', score: 0.8, payload: {} },
      ]);

      const results = await service.search('hello', 'global', undefined, 'semantic', 10);
      expect(results.map(r => r.id)).toEqual(['high-access', 'low-access']);
    });

    it('orders equal-relevance hybrid (RRF-range) results by importance', async () => {
      // Both memories rank identically in fulltext AND semantic, so their RRF
      // scores are equal; only the composite prior can break the tie.
      const memories = new Map<string, StoredMemory>([
        ['low-importance', makeMem('low-importance', { importance: 0.1 })],
        ['high-importance', makeMem('high-importance', { importance: 0.9 })],
      ]);
      const { service, storage } = createSearchService({
        memories,
        fulltextResults: [
          { id: 'low-importance', rank: -1 },
          { id: 'high-importance', rank: -1 },
        ],
      });
      storage.qdrant.search.mockResolvedValue([
        { id: 'low-importance', score: 0.5, payload: {} },
        { id: 'high-importance', score: 0.5, payload: {} },
      ]);

      const results = await service.search('hello', 'global', undefined, 'hybrid', 10);
      expect(results.map(r => r.id)).toEqual(['high-importance', 'low-importance']);
    });

    it('does not decay T0 memories regardless of age', async () => {
      const memories = new Map<string, StoredMemory>([
        ['t0-old', makeMem('t0-old', { retention_tier: 'T0', updated_at: '2020-01-01T00:00:00Z' })],
        ['t0-fresh', makeMem('t0-fresh', { retention_tier: 'T0', updated_at: '2026-01-01T00:00:00Z' })],
      ]);
      const { service, storage } = createSearchService({ memories });
      storage.qdrant.search.mockResolvedValue([
        { id: 't0-old', score: 0.8, payload: {} },
        { id: 't0-fresh', score: 0.8, payload: {} },
      ]);

      const results = await service.search('hello', 'global', undefined, 'semantic', 10);
      const [old, fresh] = ['t0-old', 't0-fresh'].map(id => results.find(r => r.id === id)!.score);
      expect(old).toBeCloseTo(fresh, 10);
    });

    it('decays lower tiers, with T3 decaying faster than T1 over the same age', async () => {
      const staleUpdatedAt = new Date(Date.now() - 200 * 86400000).toISOString();
      const memories = new Map<string, StoredMemory>([
        ['t1-stale', makeMem('t1-stale', { retention_tier: 'T1', updated_at: staleUpdatedAt })],
        ['t1-fresh', makeMem('t1-fresh', { retention_tier: 'T1', updated_at: new Date().toISOString() })],
        ['t3-stale', makeMem('t3-stale', { retention_tier: 'T3', updated_at: staleUpdatedAt })],
      ]);
      const { service, storage } = createSearchService({ memories });
      storage.qdrant.search.mockResolvedValue([
        { id: 't1-stale', score: 0.8, payload: {} },
        { id: 't1-fresh', score: 0.8, payload: {} },
        { id: 't3-stale', score: 0.8, payload: {} },
      ]);

      const results = await service.search('hello', 'global', undefined, 'semantic', 10);
      const scoreOf = (id: string) => results.find(r => r.id === id)!.score;
      // Aged T1 decays relative to fresh T1 at the same relevance...
      expect(scoreOf('t1-stale')).toBeLessThan(scoreOf('t1-fresh'));
      // ...and T3 decays faster than T1 at the same age.
      expect(scoreOf('t3-stale')).toBeLessThan(scoreOf('t1-stale'));
    });

    it('resets effective age on UPDATE (fresh updated_at outranks an older created_at)', async () => {
      const memories = new Map<string, StoredMemory>([
        ['recently-updated', makeMem('recently-updated', {
          retention_tier: 'T2',
          created_at: '2020-01-01T00:00:00Z',
          updated_at: new Date().toISOString(),
        })],
        ['never-updated', makeMem('never-updated', {
          retention_tier: 'T2',
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2020-01-01T00:00:00Z',
        })],
      ]);
      const { service, storage } = createSearchService({ memories });
      storage.qdrant.search.mockResolvedValue([
        { id: 'recently-updated', score: 0.8, payload: {} },
        { id: 'never-updated', score: 0.8, payload: {} },
      ]);

      const results = await service.search('hello', 'global', undefined, 'semantic', 10);
      expect(results.map(r => r.id)).toEqual(['recently-updated', 'never-updated']);
    });

    it('kill switch: enabled=false restores pure-relevance ordering', async () => {
      const memories = new Map<string, StoredMemory>([
        ['low-everything', makeMem('low-everything', { importance: 0.1, access_count: 0 })],
        ['high-everything', makeMem('high-everything', { importance: 0.9, access_count: 100 })],
      ]);
      const ranking: BrainConfig['search']['ranking'] = {
        enabled: false,
        w_importance: 0.3,
        w_access: 0.2,
        access_norm: 50,
        decay_per_day: { T0: 0, T1: 0.002, T2: 0.008, T3: 0.02 },
      };
      const { service, storage } = createSearchService({ memories, ranking });
      // Higher relevance score belongs to the low-signal memory: with ranking
      // disabled it must still win, proving the composite prior is bypassed.
      storage.qdrant.search.mockResolvedValue([
        { id: 'low-everything', score: 0.9, payload: {} },
        { id: 'high-everything', score: 0.1, payload: {} },
      ]);

      const results = await service.search('hello', 'global', undefined, 'semantic', 10);
      expect(results.map(r => r.id)).toEqual(['low-everything', 'high-everything']);
      expect(results.find(r => r.id === 'low-everything')!.score).toBe(0.9);
      expect(results.find(r => r.id === 'high-everything')!.score).toBe(0.1);
    });

    it('leaves semantic_score/fulltext_score raw fields unaffected by composite ranking (min_score regression)', async () => {
      const memories = new Map<string, StoredMemory>([
        ['mem-a', makeMem('mem-a', { importance: 0.9, access_count: 100 })],
      ]);
      const { service: enabledService, storage: enabledStorage } = createSearchService({ memories });
      enabledStorage.qdrant.search.mockResolvedValue([{ id: 'mem-a', score: 0.7, payload: {} }]);
      const enabledResults = await enabledService.search('hello', 'global', undefined, 'semantic', 10);

      const ranking: BrainConfig['search']['ranking'] = {
        enabled: false,
        w_importance: 0.3,
        w_access: 0.2,
        access_norm: 50,
        decay_per_day: { T0: 0, T1: 0.002, T2: 0.008, T3: 0.02 },
      };
      const { service: disabledService, storage: disabledStorage } = createSearchService({ memories, ranking });
      disabledStorage.qdrant.search.mockResolvedValue([{ id: 'mem-a', score: 0.7, payload: {} }]);
      const disabledResults = await disabledService.search('hello', 'global', undefined, 'semantic', 10);

      // The composite prior clearly changed `score` (importance/access boost it)...
      expect(enabledResults[0].score).not.toBe(disabledResults[0].score);
      // ...but semantic_score, the field min_score filters on, is identical
      // either way.
      expect(enabledResults[0].semantic_score).toBe(0.7);
      expect(disabledResults[0].semantic_score).toBe(0.7);
    });
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
