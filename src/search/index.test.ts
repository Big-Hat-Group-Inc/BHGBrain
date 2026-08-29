import { describe, it, expect, vi } from 'vitest';
import { SearchService } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { MemoryRecord, SearchResult } from '../domain/types.js';
import type { StorageManager } from '../storage/index.js';

type StoredMemory = Omit<MemoryRecord, 'embedding'>;

describe('SearchService', () => {
  function createSearchService(opts: {
    fulltextResults?: Array<{ id: string; rank: number }>;
    memories?: Map<string, StoredMemory>;
    slidingWindowEnabled?: boolean;
    ranking?: BrainConfig['search']['ranking'];
    mmr?: BrainConfig['search']['mmr'];
    queryExpansion?: BrainConfig['search']['query_expansion'];
    queryExpansionProvider?: import('./query-expansion.js').QueryExpansionProvider;
    rerankProvider?: import('../rerank/index.js').RerankProvider;
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
        // add-recall-feedback-signal: present on the mock so a regression
        // test can assert search() never touches it (composite ranking
        // must stay inert to recorded feedback in this version).
        recordFeedback: vi.fn(),
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
        // Defaults to disabled here so every pre-existing test (written
        // before add-mmr-diversity-reranking) keeps exercising byte-identical
        // store-call arguments; tests exercising MMR explicitly pass `mmr`.
        mmr: opts.mmr ?? {
          enabled: false,
          lambda: 0.7,
          candidate_pool_multiplier: 3,
          candidate_pool_cap: 50,
        },
        // Mirrors the production default (add-multi-query-expansion) so
        // pre-existing tests exercise the real default behavior; every query
        // used elsewhere in this file ('hello', 'deployment task') has no
        // stopwords to strip, so `buildVariants` still yields exactly one
        // variant and every pre-existing store-call assertion is unaffected.
        // Tests exercising expansion itself pass `queryExpansion` explicitly.
        query_expansion: opts.queryExpansion ?? {
          enabled: true,
          max_variants: 2,
          keyword_stripped: true,
          llm_paraphrase: { enabled: false, mode: 'paraphrase', variant_count: 2, timeout_ms: 3000 },
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

    // `embedBatch` delegates to the same underlying `embed` mock (one call per
    // text) rather than an independent stub, so tests that simulate an outage
    // via `embedding.embed.mockRejectedValue(...)` still see that failure
    // whether the code path under test calls `embed` (query expansion
    // disabled) or `embedBatch` (query expansion enabled, the default here) —
    // mirroring how the real `OpenAIEmbeddingProvider.embed` is itself
    // implemented as `embedBatch([text])[0]`.
    const embedMock = vi.fn(async () => [1, 2, 3]);
    const embedding = {
      model: 'test-model',
      dimensions: 3,
      embed: embedMock,
      embedBatch: vi.fn(async (texts: string[]) => Promise.all(texts.map(() => embedMock()))),
      healthCheck: vi.fn(async () => true),
    } as EmbeddingProvider;

    const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn() } as unknown as MetricsCollector;
    const logger = { warn: vi.fn() };

    return {
      service: new SearchService(
        config, storage, embedding, metrics, logger, opts.queryExpansionProvider, opts.rerankProvider,
      ),
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

  it('a pinned memory is unaffected by pinned state: no pinned field, ordering unchanged (add-inject-pinning 5.12)', async () => {
    const pinnedMem: StoredMemory = {
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
      pinned: true,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      last_accessed: '2026-01-01T00:00:00Z',
    };
    const { service } = createSearchService({ memories: new Map([['mem-1', pinnedMem]]) });
    const results = await service.search('hello', 'global', undefined, 'fulltext', 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('mem-1');
    expect('pinned' in results[0]!).toBe(false);
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
    expect(metrics.incCounter).toHaveBeenCalledWith('search_embedding_degraded', 1, { namespace: 'global' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'embedding_degraded', degraded: 'fulltext_only' }),
    );
    // Qdrant should not have been queried once embedding failed.
    expect(storage.qdrant.search).not.toHaveBeenCalled();
  });

  it('accumulates search_embedding_degraded independently per namespace (add-retrieval-quality-metrics 3.3)', async () => {
    const { service: serviceA, embedding: embeddingA, metrics: metricsA } = createSearchService();
    (embeddingA.embed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('embeddings down'));
    await serviceA.search('hello', 'team-a', undefined, 'hybrid', 10);
    expect(metricsA.incCounter).toHaveBeenCalledWith('search_embedding_degraded', 1, { namespace: 'team-a' });

    const { service: serviceB, embedding: embeddingB, metrics: metricsB } = createSearchService();
    (embeddingB.embed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('embeddings down'));
    await serviceB.search('hello', 'team-b', undefined, 'hybrid', 10);
    expect(metricsB.incCounter).toHaveBeenCalledWith('search_embedding_degraded', 1, { namespace: 'team-b' });
  });

  describe('retrieval quality metrics (add-retrieval-quality-metrics)', () => {
    it('records search_result_count and search_result_score for a semantic-mode search', async () => {
      const { service, storage, metrics } = createSearchService();
      storage.qdrant.search.mockResolvedValue([
        { id: 'mem-1', score: 0.8, payload: {} },
      ]);

      const results = await service.search('hello', 'global', undefined, 'semantic', 10);

      expect(results.length).toBeGreaterThan(0);
      expect(metrics.recordHistogram).toHaveBeenCalledWith('search_result_count', results.length, { mode: 'semantic' });
      for (const r of results) {
        expect(metrics.recordHistogram).toHaveBeenCalledWith('search_result_score', r.score, { mode: 'semantic' });
      }
    });

    it('records search_result_count and search_result_score for a fulltext-mode search', async () => {
      const { service, metrics } = createSearchService();

      const results = await service.search('hello', 'global', undefined, 'fulltext', 10);

      expect(results.length).toBeGreaterThan(0);
      expect(metrics.recordHistogram).toHaveBeenCalledWith('search_result_count', results.length, { mode: 'fulltext' });
      for (const r of results) {
        expect(metrics.recordHistogram).toHaveBeenCalledWith('search_result_score', r.score, { mode: 'fulltext' });
      }
    });

    it('records search_result_count and search_result_score for a hybrid-mode search', async () => {
      const { service, metrics } = createSearchService();

      const results = await service.search('hello', 'global', undefined, 'hybrid', 10);

      expect(results.length).toBeGreaterThan(0);
      expect(metrics.recordHistogram).toHaveBeenCalledWith('search_result_count', results.length, { mode: 'hybrid' });
      for (const r of results) {
        expect(metrics.recordHistogram).toHaveBeenCalledWith('search_result_score', r.score, { mode: 'hybrid' });
      }
    });

    it('records a zero search_result_count and no score samples for a zero-result search', async () => {
      const { service, metrics } = createSearchService();
      // Default fixture's semantic leg (storage.qdrant.search) resolves to
      // [] and no memory named 'nothing-matches-this' exists in fulltext.
      const results = await service.search('hello', 'global', undefined, 'semantic', 10);

      expect(results).toHaveLength(0);
      expect(metrics.recordHistogram).toHaveBeenCalledWith('search_result_count', 0, { mode: 'semantic' });
      expect(metrics.recordHistogram).not.toHaveBeenCalledWith('search_result_score', expect.anything(), { mode: 'semantic' });
    });

    it('does not add archived matches to search_result_score, even though they are appended to the return value', async () => {
      const { service, storage, metrics } = createSearchService();
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

      // The active (non-archived) result count is recorded, not the
      // post-archived-append total.
      const activeCount = results.filter(r => !r.archived).length;
      expect(metrics.recordHistogram).toHaveBeenCalledWith('search_result_count', activeCount, { mode: 'fulltext' });
      // The archived match's placeholder score (0) is never recorded to
      // search_result_score.
      const scoreCalls = (metrics.recordHistogram as ReturnType<typeof vi.fn>).mock.calls.filter(
        call => call[0] === 'search_result_score' && call[2]?.mode === 'fulltext',
      );
      expect(scoreCalls).toHaveLength(activeCount);
    });
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

    // Regression guard for add-recall-feedback-signal: recall_feedback is a
    // purely additive, write-only event stream that composite ranking must
    // never read from — recorded feedback (in any quantity or mix of
    // `useful` values) has no read/list surface and no wiring into
    // buildSearchResults in this version (design.md Non-Goals).
    it('never touches recall_feedback: composite ranking stays inert to recorded feedback', async () => {
      // Freeze time across both search() calls: the composite prior's decay
      // term is a function of Date.now(), so without pinning it, two calls
      // separated by even a few milliseconds of real wall-clock time produce
      // spuriously different scores that would drown out the actual signal
      // under test (recall_feedback's effect, which should be exactly zero).
      vi.useFakeTimers();
      try {
        const memories = new Map<string, StoredMemory>([
          ['mem-a', makeMem('mem-a', { importance: 0.9, access_count: 100 })],
        ]);
        const { service, storage } = createSearchService({ memories });
        storage.qdrant.search.mockResolvedValue([{ id: 'mem-a', score: 0.7, payload: {} }]);

        const baselineResults = await service.search('hello', 'global', undefined, 'semantic', 10);

        // Simulate feedback having been recorded for this memory, in bulk and
        // in a mix of verdicts, exactly the scenario the spec calls out.
        for (let i = 0; i < 5; i++) {
          storage.sqlite.recordFeedback({
            memory_id: 'mem-a', namespace: 'global', query: 'hello', score: 0.7,
            useful: i % 2 === 0, client_id: 'c1', created_at: new Date().toISOString(),
          });
        }

        const afterFeedbackResults = await service.search('hello', 'global', undefined, 'semantic', 10);

        // search() itself never calls into recordFeedback (or any
        // feedback-reading method) — the only calls on that mock are the ones
        // this test made directly above.
        expect(storage.sqlite.recordFeedback).toHaveBeenCalledTimes(5);
        expect(baselineResults[0].score).toBe(afterFeedbackResults[0].score);
        expect(baselineResults.map(r => r.id)).toEqual(afterFeedbackResults.map(r => r.id));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('MMR diversity reranking (add-mmr-diversity-reranking)', () => {
    const makeMem = (id: string, overrides: Partial<StoredMemory> = {}): StoredMemory => ({
      id, namespace: 'global', collection: 'general', type: 'semantic',
      content: `content-${id}`, summary: `summary-${id}`, tags: [], source: 'cli',
      checksum: id,
      importance: 0.5,
      retention_tier: 'T0',
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

    // Same importance/access_count/retention_tier (T0, no decay) for every
    // fixture memory below so the composite prior is a constant multiplier
    // across the pool — it never perturbs relative order, isolating MMR's
    // own reordering effect from add-composite-recall-ranking's.
    const mmrConfig = (overrides: Partial<BrainConfig['search']['mmr']> = {}): BrainConfig['search']['mmr'] => ({
      enabled: true,
      lambda: 0.7,
      candidate_pool_multiplier: 3,
      candidate_pool_cap: 50,
      ...overrides,
    });

    it('promotes a distinct memory into the top-K ahead of a near-duplicate when enabled, not when disabled', async () => {
      const memories = new Map<string, StoredMemory>([
        ['a', makeMem('a')],
        ['b-near-dup', makeMem('b-near-dup')],
        ['d-distinct', makeMem('d-distinct')],
      ]);
      const qdrantResults = [
        { id: 'a', score: 0.95, payload: {}, vector: [1, 0] },
        // Near-duplicate of 'a' (cosine similarity ~0.9998).
        { id: 'b-near-dup', score: 0.94, payload: {}, vector: [0.9998, 0.02] },
        // Orthogonal to 'a'/'b' — genuinely distinct, lower relevance.
        { id: 'd-distinct', score: 0.80, payload: {}, vector: [0, 1] },
      ];

      const { service: enabledService, storage: enabledStorage } = createSearchService({
        memories, mmr: mmrConfig({ lambda: 0.5 }),
      });
      enabledStorage.qdrant.search.mockResolvedValue(qdrantResults);
      const enabledResults = await enabledService.search('hello', 'global', undefined, 'semantic', 3);
      // Full-pool reorder: every candidate still present, just reordered.
      expect(enabledResults.map(r => r.id).sort()).toEqual(['a', 'b-near-dup', 'd-distinct'].sort());
      const enabledTop2 = enabledResults.slice(0, 2).map(r => r.id);
      expect(enabledTop2).toContain('d-distinct');

      const { service: disabledService, storage: disabledStorage } = createSearchService({
        memories, mmr: mmrConfig({ enabled: false }),
      });
      disabledStorage.qdrant.search.mockResolvedValue(qdrantResults);
      const disabledResults = await disabledService.search('hello', 'global', undefined, 'semantic', 3);
      const disabledTop2 = disabledResults.slice(0, 2).map(r => r.id);
      // Pure composite-relevance ordering: the distinct-but-lower-relevance
      // memory stays outside the top 2, unlike the enabled case above.
      expect(disabledTop2).toEqual(['a', 'b-near-dup']);
      expect(disabledTop2).not.toContain('d-distinct');
    });

    it('lambda close to 1 reduces to (near) pure composite-relevance ordering', async () => {
      const memories = new Map<string, StoredMemory>([
        ['a', makeMem('a')],
        ['b-near-dup', makeMem('b-near-dup')],
        ['d-distinct', makeMem('d-distinct')],
      ]);
      const qdrantResults = [
        { id: 'a', score: 0.95, payload: {}, vector: [1, 0] },
        { id: 'b-near-dup', score: 0.90, payload: {}, vector: [0.9998, 0.02] },
        { id: 'd-distinct', score: 0.70, payload: {}, vector: [0, 1] },
      ];

      const { service, storage } = createSearchService({ memories, mmr: mmrConfig({ lambda: 1 }) });
      storage.qdrant.search.mockResolvedValue(qdrantResults);
      const results = await service.search('hello', 'global', undefined, 'semantic', 3);

      expect(results.map(r => r.id)).toEqual(['a', 'b-near-dup', 'd-distinct']);
    });

    it('a low lambda visibly favors a dissimilar candidate over a marginally-more-relevant near-duplicate', async () => {
      const memories = new Map<string, StoredMemory>([
        ['p1', makeMem('p1')],
        ['p2-near-dup', makeMem('p2-near-dup')],
        ['q-distinct', makeMem('q-distinct')],
      ]);
      const qdrantResults = [
        { id: 'p1', score: 0.95, payload: {}, vector: [1, 0] },
        { id: 'p2-near-dup', score: 0.93, payload: {}, vector: [0.999, 0.045] },
        { id: 'q-distinct', score: 0.85, payload: {}, vector: [0, 1] },
      ];

      const { service, storage } = createSearchService({ memories, mmr: mmrConfig({ lambda: 0.1 }) });
      storage.qdrant.search.mockResolvedValue(qdrantResults);
      const results = await service.search('hello', 'global', undefined, 'semantic', 3);

      // 'q-distinct' (well-separated, marginally lower relevance) is promoted
      // ahead of 'p2-near-dup' (near-duplicate of the top result), unlike
      // the pure-relevance order (p1, p2-near-dup, q-distinct).
      expect(results.map(r => r.id)).toEqual(['p1', 'q-distinct', 'p2-near-dup']);
    });

    it('mode: fulltext is unaffected by search.mmr.enabled (no vectors to diversify against)', async () => {
      const memories = new Map<string, StoredMemory>([
        ['f1', makeMem('f1')],
        ['f2', makeMem('f2')],
      ]);
      const fulltextResults = [{ id: 'f1', rank: -2 }, { id: 'f2', rank: -1 }];

      const { service: enabledService, storage: enabledStorage } = createSearchService({
        memories, fulltextResults, mmr: mmrConfig({ enabled: true }),
      });
      const enabledResults = await enabledService.search('hello', 'global', undefined, 'fulltext', 10);

      const { service: disabledService } = createSearchService({
        memories, fulltextResults, mmr: mmrConfig({ enabled: false }),
      });
      const disabledResults = await disabledService.search('hello', 'global', undefined, 'fulltext', 10);

      expect(enabledResults.map(r => r.id)).toEqual(disabledResults.map(r => r.id));
      // No vector ever requested for fulltext, enabled or not.
      expect(enabledStorage.qdrant.search).not.toHaveBeenCalled();
    });

    it('diversifies consistently across cosine-scale (semantic) and RRF-scale (hybrid) score magnitudes (normalization regression)', async () => {
      // Same relative shape in both modes: a top result, a near-duplicate of
      // it with slightly lower relevance, and a well-separated, lower-relevance
      // distinct memory. At a high lambda, the diversity term should not
      // dominate in either mode purely because hybrid's RRF scores are ~100x
      // smaller in magnitude than semantic's cosine-range scores.
      const memories = new Map<string, StoredMemory>([
        ['p1', makeMem('p1')],
        ['p2-near-dup', makeMem('p2-near-dup')],
        ['q-distinct', makeMem('q-distinct')],
      ]);
      const vectors: Record<string, number[]> = {
        p1: [1, 0],
        'p2-near-dup': [0.999, 0.045],
        'q-distinct': [0, 1],
      };

      const { service: semanticService, storage: semanticStorage } = createSearchService({
        memories, mmr: mmrConfig({ lambda: 0.9 }),
      });
      semanticStorage.qdrant.search.mockResolvedValue([
        { id: 'p1', score: 0.95, payload: {}, vector: vectors.p1 },
        { id: 'p2-near-dup', score: 0.90, payload: {}, vector: vectors['p2-near-dup'] },
        { id: 'q-distinct', score: 0.70, payload: {}, vector: vectors['q-distinct'] },
      ]);
      const semanticResults = await semanticService.search('hello', 'global', undefined, 'semantic', 3);

      // Hybrid mode: rank-derived RRF scores are tiny (~0.011, see RRF_K=60
      // in src/search/index.ts) — far smaller in absolute magnitude than the
      // ~[0,1] cosine similarities used for the diversity term.
      const { service: hybridService, storage: hybridStorage } = createSearchService({
        memories, mmr: mmrConfig({ lambda: 0.9 }), fulltextResults: [],
      });
      hybridStorage.qdrant.search.mockResolvedValue([
        { id: 'p1', score: 0.95, payload: {}, vector: vectors.p1 },
        { id: 'p2-near-dup', score: 0.90, payload: {}, vector: vectors['p2-near-dup'] },
        { id: 'q-distinct', score: 0.70, payload: {}, vector: vectors['q-distinct'] },
      ]);
      const hybridResults = await hybridService.search('hello', 'global', undefined, 'hybrid', 3);

      // Both modes preserve (near-)pure-relevance ordering at high lambda,
      // despite wildly different raw score scales — proof the min-max
      // normalization equalizes `lambda`'s meaning across modes.
      expect(semanticResults.map(r => r.id)).toEqual(['p1', 'p2-near-dup', 'q-distinct']);
      expect(hybridResults.map(r => r.id)).toEqual(['p1', 'p2-near-dup', 'q-distinct']);
    });

    it('never leaks the transient MMR-scratch vector into search() output, enabled or disabled', async () => {
      const memories = new Map<string, StoredMemory>([
        ['a', makeMem('a')],
        ['b', makeMem('b')],
      ]);
      const qdrantResults = [
        { id: 'a', score: 0.9, payload: {}, vector: [1, 0] },
        { id: 'b', score: 0.8, payload: {}, vector: [0, 1] },
      ];

      const { service: enabledService, storage: enabledStorage } = createSearchService({
        memories, mmr: mmrConfig({ enabled: true }),
      });
      enabledStorage.qdrant.search.mockResolvedValue(qdrantResults);
      const enabledResults = await enabledService.search('hello', 'global', undefined, 'semantic', 5);
      expect(enabledResults.every(r => r.vector === undefined)).toBe(true);
      expect(JSON.stringify(enabledResults)).not.toContain('"vector"');

      const { service: disabledService, storage: disabledStorage } = createSearchService({
        memories, mmr: mmrConfig({ enabled: false }),
      });
      disabledStorage.qdrant.search.mockResolvedValue(qdrantResults);
      const disabledResults = await disabledService.search('hello', 'global', undefined, 'semantic', 5);
      expect(disabledResults.every(r => r.vector === undefined)).toBe(true);
      expect(JSON.stringify(disabledResults)).not.toContain('"vector"');

      // searchForInject's existing vector-carrying contract is unaffected.
      const injectResults = await enabledService.searchForInject('hello', 'global', 5);
      expect(injectResults.some(r => r.vector !== undefined)).toBe(true);
    });
  });

  describe('multi-query expansion (add-multi-query-expansion)', () => {
    const expansionMakeMem = (id: string): StoredMemory => ({
      id, namespace: 'global', collection: 'general', type: 'semantic',
      content: `content-${id}`, summary: `summary-${id}`, tags: [], source: 'cli',
      checksum: id,
      importance: 0.5,
      retention_tier: 'T2',
      expires_at: null,
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

    // No composite-ranking distortion in this describe block: every test
    // here asserts on raw merge/limit/routing behavior, so ranking is
    // disabled to make `score`/`semantic_score` directly comparable to the
    // scores the qdrant.search mocks hand back.
    const noRanking = {
      enabled: false, w_importance: 0, w_access: 0, access_norm: 1,
      decay_per_day: { T0: 0, T1: 0, T2: 0, T3: 0 },
    } as unknown as BrainConfig['search']['ranking'];

    it('surfaces a memory the literal query alone would miss via the keyword-stripped variant', async () => {
      const memories = new Map<string, StoredMemory>([
        ['mem-literal', expansionMakeMem('mem-literal')],
        ['mem-keyword-only', expansionMakeMem('mem-keyword-only')],
      ]);
      const { service, storage, embedding } = createSearchService({ memories, ranking: noRanking });
      (embedding.embedBatch as ReturnType<typeof vi.fn>).mockImplementation(async (texts: string[]) =>
        texts.map(t => (t === 'deploy' ? [9, 9, 9] : [1, 2, 3])));
      storage.qdrant.search.mockImplementation(async (_ns: string, _col: string | undefined, vector: number[]) =>
        vector[0] === 9
          ? [{ id: 'mem-keyword-only', score: 0.95, payload: {} }]
          : [{ id: 'mem-literal', score: 0.5, payload: {} }]);

      const results = await service.search('how do we deploy', 'global', undefined, 'semantic', 10);

      expect(results.map(r => r.id).sort()).toEqual(['mem-keyword-only', 'mem-literal']);
    });

    it('keeps the max score, not a sum, when a memory id is matched by more than one variant', async () => {
      const memories = new Map<string, StoredMemory>([['mem-1', expansionMakeMem('mem-1')]]);
      const { service, storage, embedding } = createSearchService({ memories, ranking: noRanking });
      (embedding.embedBatch as ReturnType<typeof vi.fn>).mockImplementation(async (texts: string[]) =>
        texts.map(t => (t === 'deploy' ? [9, 9, 9] : [1, 2, 3])));
      storage.qdrant.search.mockImplementation(async (_ns: string, _col: string | undefined, vector: number[]) =>
        vector[0] === 9
          ? [{ id: 'mem-1', score: 0.9, payload: {} }]
          : [{ id: 'mem-1', score: 0.4, payload: {} }]);

      const results = await service.search('how do we deploy', 'global', undefined, 'semantic', 10);

      expect(results).toHaveLength(1);
      expect(results[0]!.semantic_score).toBe(0.9);
      expect(results[0]!.score).toBe(0.9);
    });

    it('still bounds the result count by limit when expansion widens the candidate pool', async () => {
      const memories = new Map<string, StoredMemory>(
        ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'].map(id => [id, expansionMakeMem(id)]),
      );
      const { service, storage, embedding } = createSearchService({ memories, ranking: noRanking });
      (embedding.embedBatch as ReturnType<typeof vi.fn>).mockImplementation(async (texts: string[]) =>
        texts.map(t => (t === 'deploy' ? [9, 9, 9] : [1, 2, 3])));
      storage.qdrant.search.mockImplementation(async (_ns: string, _col: string | undefined, vector: number[]) =>
        vector[0] === 9
          ? [{ id: 'b1', score: 0.9, payload: {} }, { id: 'b2', score: 0.8, payload: {} }, { id: 'b3', score: 0.7, payload: {} }]
          : [{ id: 'a1', score: 0.6, payload: {} }, { id: 'a2', score: 0.5, payload: {} }, { id: 'a3', score: 0.4, payload: {} }]);

      const results = await service.search('how do we deploy', 'global', undefined, 'semantic', 3);

      expect(results).toHaveLength(3);
      // Highest-scoring 3 across both variants' 6 distinct candidates.
      expect(results.map(r => r.id)).toEqual(['b1', 'b2', 'b3']);
    });

    it('kill switch: query_expansion.enabled=false embeds the literal query only, via embed not embedBatch', async () => {
      const { service, embedding } = createSearchService({
        queryExpansion: {
          enabled: false, max_variants: 2, keyword_stripped: true,
          llm_paraphrase: { enabled: false, mode: 'paraphrase', variant_count: 2, timeout_ms: 3000 },
        },
      });

      await service.search('how do we deploy', 'global', undefined, 'semantic', 10);

      expect(embedding.embed).toHaveBeenCalledWith('how do we deploy');
      expect(embedding.embedBatch).not.toHaveBeenCalled();
    });

    it('hybridSearch: semantic-leg expansion merges into RRF while the fulltext leg is queried once with the original query', async () => {
      const memories = new Map<string, StoredMemory>([
        ['mem-literal', expansionMakeMem('mem-literal')],
        ['mem-keyword-only', expansionMakeMem('mem-keyword-only')],
      ]);
      const { service, storage, embedding } = createSearchService({
        memories, ranking: noRanking, fulltextResults: [],
      });
      (embedding.embedBatch as ReturnType<typeof vi.fn>).mockImplementation(async (texts: string[]) =>
        texts.map(t => (t === 'deploy' ? [9, 9, 9] : [1, 2, 3])));
      storage.qdrant.search.mockImplementation(async (_ns: string, _col: string | undefined, vector: number[]) =>
        vector[0] === 9
          ? [{ id: 'mem-keyword-only', score: 0.95 }]
          : [{ id: 'mem-literal', score: 0.5 }]);

      const results = await service.search('how do we deploy', 'global', undefined, 'hybrid', 10);

      expect(results.map(r => r.id).sort()).toEqual(['mem-keyword-only', 'mem-literal']);
      expect(storage.sqlite.fullTextSearch).toHaveBeenCalledTimes(1);
      expect(storage.sqlite.fullTextSearch).toHaveBeenCalledWith('global', 'how do we deploy', 20, undefined);
    });

    it('phase 2: LLM paraphrase variants widen the candidate pool, capped by max_variants', async () => {
      const memories = new Map<string, StoredMemory>([
        ['mem-literal', expansionMakeMem('mem-literal')],
        ['mem-keyword-only', expansionMakeMem('mem-keyword-only')],
        ['mem-llm-only', expansionMakeMem('mem-llm-only')],
      ]);
      const queryExpansionProvider = {
        configured: true,
        generateVariants: vi.fn(async () => ['paraphrase one', 'paraphrase two']),
      };
      const { service, storage, embedding } = createSearchService({
        memories,
        ranking: noRanking,
        queryExpansion: {
          enabled: true, max_variants: 5, keyword_stripped: true,
          llm_paraphrase: { enabled: true, mode: 'paraphrase', variant_count: 2, timeout_ms: 3000 },
        },
        queryExpansionProvider,
      });
      (embedding.embedBatch as ReturnType<typeof vi.fn>).mockImplementation(async (texts: string[]) =>
        texts.map(t => {
          if (t === 'deploy') return [9, 9, 9];
          if (t === 'paraphrase one') return [7, 7, 7];
          return [1, 2, 3];
        }));
      storage.qdrant.search.mockImplementation(async (_ns: string, _col: string | undefined, vector: number[]) => {
        if (vector[0] === 9) return [{ id: 'mem-keyword-only', score: 0.8, payload: {} }];
        if (vector[0] === 7) return [{ id: 'mem-llm-only', score: 0.85, payload: {} }];
        return [{ id: 'mem-literal', score: 0.5, payload: {} }];
      });

      const results = await service.search('how do we deploy', 'global', undefined, 'semantic', 10);

      expect(queryExpansionProvider.generateVariants).toHaveBeenCalledWith('how do we deploy', 'paraphrase', 2, 3000);
      // original + keyword + 2 LLM variants = 4, under max_variants=5, so
      // both LLM-only and keyword-only candidates are searched for.
      expect(results.map(r => r.id).sort()).toEqual(['mem-keyword-only', 'mem-literal', 'mem-llm-only']);
    });

    it('degrades to phase-1-only variants when the LLM provider fails mid-call, without an unhandled rejection', async () => {
      const memories = new Map<string, StoredMemory>([
        ['mem-literal', expansionMakeMem('mem-literal')],
        ['mem-keyword-only', expansionMakeMem('mem-keyword-only')],
      ]);
      const queryExpansionProvider = {
        configured: true,
        generateVariants: vi.fn(async () => {
          throw new Error('extraction endpoint timed out');
        }),
      };
      const { service, storage, embedding } = createSearchService({
        memories,
        ranking: noRanking,
        queryExpansion: {
          enabled: true, max_variants: 5, keyword_stripped: true,
          llm_paraphrase: { enabled: true, mode: 'paraphrase', variant_count: 2, timeout_ms: 3000 },
        },
        queryExpansionProvider,
      });
      (embedding.embedBatch as ReturnType<typeof vi.fn>).mockImplementation(async (texts: string[]) =>
        texts.map(t => (t === 'deploy' ? [9, 9, 9] : [1, 2, 3])));
      storage.qdrant.search.mockImplementation(async (_ns: string, _col: string | undefined, vector: number[]) =>
        vector[0] === 9
          ? [{ id: 'mem-keyword-only', score: 0.9, payload: {} }]
          : [{ id: 'mem-literal', score: 0.5, payload: {} }]);

      // Resolves without throwing, and reflects only the phase-1 (original +
      // keyword) variants — the LLM provider's failure never reaches the
      // caller.
      const results = await service.search('how do we deploy', 'global', undefined, 'semantic', 10);
      expect(results.map(r => r.id).sort()).toEqual(['mem-keyword-only', 'mem-literal']);
    });
  });

  // add-opt-in-rerank-stage
  describe('rerank', () => {
    function fakeResult(id: string, score: number): SearchResult {
      return {
        id,
        content: `content for ${id}`,
        summary: id,
        type: 'semantic',
        tags: [],
        score,
        retention_tier: 'T2',
        created_at: '2026-01-01T00:00:00Z',
        last_accessed: '2026-01-01T00:00:00Z',
      };
    }

    it('is a no-op when no rerank provider is injected', async () => {
      const { service } = createSearchService();
      const results = [fakeResult('a', 0.5), fakeResult('b', 0.9)];
      const reranked = await service.rerank('q', results, 20);
      expect(reranked).toBe(results);
    });

    it('replaces score and sets rerank_score only for scored candidates within poolSize', async () => {
      const rerankProvider = {
        provider: 'openai',
        score: vi.fn(async () => new Map([['a', 0.1], ['b', 0.95]])),
      };
      const { service } = createSearchService({ rerankProvider });
      const results = [fakeResult('a', 0.5), fakeResult('b', 0.4), fakeResult('c', 0.3)];
      const reranked = await service.rerank('q', results, 2);

      expect(rerankProvider.score).toHaveBeenCalledWith('q', [
        { id: 'a', text: 'content for a' },
        { id: 'b', text: 'content for b' },
      ]);

      const byId = new Map(reranked.map(r => [r.id, r]));
      expect(byId.get('a')).toMatchObject({ score: 0.1, rerank_score: 0.1 });
      expect(byId.get('b')).toMatchObject({ score: 0.95, rerank_score: 0.95 });
      // Outside the pool: untouched, no rerank_score.
      expect(byId.get('c')).toMatchObject({ score: 0.3 });
      expect(byId.get('c')?.rerank_score).toBeUndefined();
    });

    it('keeps unscored candidates from a partial response at their pre-rerank score', async () => {
      const rerankProvider = {
        provider: 'openai',
        // Only scores 'a'; 'b' is omitted (simulating a partial LLM response).
        score: vi.fn(async () => new Map([['a', 0.2]])),
      };
      const { service } = createSearchService({ rerankProvider });
      const results = [fakeResult('a', 0.5), fakeResult('b', 0.6)];
      const reranked = await service.rerank('q', results, 20);

      const byId = new Map(reranked.map(r => [r.id, r]));
      expect(byId.get('a')).toMatchObject({ score: 0.2, rerank_score: 0.2 });
      expect(byId.get('b')).toMatchObject({ score: 0.6 });
      expect(byId.get('b')?.rerank_score).toBeUndefined();
    });

    it('re-sorts the full list by the resulting score descending', async () => {
      const rerankProvider = {
        provider: 'openai',
        score: vi.fn(async () => new Map([['a', 0.1], ['b', 0.9]])),
      };
      const { service } = createSearchService({ rerankProvider });
      const results = [fakeResult('a', 0.99), fakeResult('b', 0.01)];
      const reranked = await service.rerank('q', results, 20);
      expect(reranked.map(r => r.id)).toEqual(['b', 'a']);
    });

    it('degrades to the pre-rerank list, counts, and logs on provider failure', async () => {
      const rerankProvider = {
        provider: 'openai',
        score: vi.fn(async () => { throw new Error('rerank api down'); }),
      };
      const { service, metrics, logger } = createSearchService({ rerankProvider });
      const results = [fakeResult('a', 0.5), fakeResult('b', 0.9)];
      const reranked = await service.rerank('q', results, 20);

      expect(reranked).toEqual(results);
      expect(metrics.incCounter).toHaveBeenCalledWith('search_rerank_degraded');
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'rerank_degraded' }));
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
