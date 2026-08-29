import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { SearchMode, SearchResult, MemoryRecord, MemoryType, RetentionTier, RecallFilter, ArchiveRecord } from '../domain/types.js';
import type { AccessUpdate } from '../storage/sqlite.js';
import type { MetricsCollector } from '../health/metrics.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';
import { embeddingUnavailable, internal } from '../errors/index.js';
import { cosineSimilarity } from './similarity.js';
import { buildVariants, type QueryExpansionProvider } from './query-expansion.js';

const RRF_K = 60;

const MEMORY_TYPES: readonly MemoryType[] = ['episodic', 'semantic', 'procedural'];
const RETENTION_TIERS: readonly RetentionTier[] = ['T0', 'T1', 'T2', 'T3'];

// Narrowing helpers for the cross-device Qdrant fallback: the payload is
// untrusted external data (a different device/version may have written it), so
// every field is validated before it can reach a SearchResult rather than
// asserted with an unchecked cast.
function narrowString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}

function isRetentionTier(value: unknown): value is RetentionTier {
  return typeof value === 'string' && (RETENTION_TIERS as readonly string[]).includes(value);
}

// Maps a retained archive row into the SearchResult shape so `include_archived`
// callers get a uniform result list. `archived_memories` keeps summary/tags/tier
// only — no content, no vector — so `content` here is the summary (the only text
// retained) and `type`/`device_id` fall back to defaults rather than claiming
// data the archive never had. `score` is a flat placeholder (not a relevance
// score; archived matches are metadata-term hits, appended rather than ranked
// alongside active results) — callers key off `archived: true`, not `score`.
function archiveRecordToSearchResult(record: ArchiveRecord): SearchResult {
  return {
    id: record.memory_id,
    content: record.summary,
    summary: record.summary,
    type: 'semantic',
    tags: record.tags,
    score: 0,
    retention_tier: record.tier,
    expires_at: null,
    expiring_soon: false,
    device_id: null,
    created_at: record.created_at,
    last_accessed: record.expired_at,
    archived: true,
  };
}

interface RankedItem {
  id: string;
  semanticRank?: number;
  fulltextRank?: number;
  semanticScore?: number;
  fulltextScore?: number;
  vector?: number[];
}

export class SearchService {
  private lifecycle: MemoryLifecycleService;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
    private metrics?: MetricsCollector,
    private logger?: { warn: (obj: Record<string, unknown>) => void },
    // Optional phase-2 (LLM paraphrase/HyDE) variant generator
    // (add-multi-query-expansion). Undefined for every caller that predates
    // this parameter, in which case query expansion runs phase-1-only
    // (deterministic keyword-stripped variant) exactly as if
    // `llm_paraphrase.enabled` were false.
    private queryExpansion?: QueryExpansionProvider,
  ) {
    this.lifecycle = new MemoryLifecycleService(config);
  }

  // Generates LLM paraphrase/HyDE variant strings for `query`, or `[]` when
  // phase 2 is disabled, unconfigured, or generation fails — this method
  // itself never throws (add-multi-query-expansion design.md "Phase 2 ...
  // degrade to phase 1 on any failure"). `QueryExpansionProvider.
  // generateVariants` already returns `[]` on internal failure; the try/catch
  // here is defense in depth so a caller-supplied provider that violates that
  // contract still can't fail a search call.
  private async generateLlmVariants(query: string): Promise<string[]> {
    const qe = this.config.search.query_expansion;
    if (!qe.enabled || !qe.llm_paraphrase.enabled) return [];
    if (!this.queryExpansion?.configured) return [];
    try {
      return await this.queryExpansion.generateVariants(
        query,
        qe.llm_paraphrase.mode,
        qe.llm_paraphrase.variant_count,
        qe.llm_paraphrase.timeout_ms,
      );
    } catch {
      return [];
    }
  }

  // Builds the embedding vectors to search for `query`: when query expansion
  // is disabled, behaves exactly as before this feature existed (a single
  // `embed` call on the literal query). When enabled, batches the original
  // query plus any deterministic/LLM variants through one `embedBatch` call
  // (add-multi-query-expansion design.md "Batching"). Returns the vector list
  // alongside the variant count actually used, for the
  // `search_query_expansion_variant_count` histogram.
  private async embedQueryVariants(query: string): Promise<{ vectors: number[][]; variantCount: number }> {
    const qe = this.config.search.query_expansion;
    if (!qe.enabled) {
      return { vectors: [await this.embedding.embed(query)], variantCount: 1 };
    }
    const llmVariants = await this.generateLlmVariants(query);
    const variants = buildVariants(query, qe, llmVariants);
    const vectors = await this.embedding.embedBatch(variants);
    return { vectors, variantCount: variants.length };
  }

  // Merges per-variant candidate arrays by `id`, keeping the max score per id
  // (add-multi-query-expansion design.md "Merge key and score fusion"), then
  // sorts descending and truncates to `limit` so query expansion widens
  // candidate *membership* without changing the per-call result-count bound.
  // Generic over the candidate shape so both `semanticSearch`'s
  // Qdrant-result-with-payload items and `hybridSearch`'s lighter
  // `{id, score, vector}` semantic-leg items reuse the same merge logic.
  private mergeVariantResults<T extends { id: string; score: number }>(
    perVariant: T[][],
    limit: number,
  ): T[] {
    const merged = new Map<string, T>();
    for (const variantResults of perVariant) {
      for (const item of variantResults) {
        const existing = merged.get(item.id);
        if (!existing || item.score > existing.score) {
          merged.set(item.id, item);
        }
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async search(
    query: string,
    namespace: string,
    collection: string | undefined,
    mode: SearchMode,
    limit: number,
    // Optional per-call out-parameter: hybrid mode sets `degraded = true` when it
    // falls back to fulltext-only, so callers can distinguish a degraded result
    // from a healthy one without changing the SearchResult[] contract.
    signal?: { degraded?: boolean },
    // Optional type/tags predicate pushed down into the stores (see
    // `push-down-recall-filters`) so `limit` counts matching memories.
    // Omitted entirely (not passed to the stores) when undefined, so
    // unfiltered callers see identical behavior to before this parameter
    // existed.
    filter?: RecallFilter,
    // Additive opt-in (add-review-and-archive-recall): archived matches are
    // fetched separately and appended after active results rather than
    // folded into ranking, so they never reduce how many active results
    // `limit` allows. Defaults false so every pre-existing caller is
    // unaffected.
    includeArchived = false,
  ): Promise<SearchResult[]> {
    const start = Date.now();
    try {
      // Whether this call is eligible for MMR diversity reordering
      // (add-mmr-diversity-reranking): only when the feature is on and the
      // mode actually carries vectors to diversify against (fulltext never
      // does). Computed once so every mode branch requests vectors
      // consistently instead of each caller threading its own boolean.
      const wantVectors = this.config.search.mmr.enabled && mode !== 'fulltext';

      let results: SearchResult[];
      switch (mode) {
        case 'semantic':
          results = await this.semanticSearch(query, namespace, collection, limit, filter, wantVectors);
          break;
        case 'fulltext':
          results = this.fulltextSearch(query, namespace, collection, limit, filter);
          break;
        case 'hybrid':
          results = await this.hybridSearch(query, namespace, collection, limit, signal, filter, wantVectors);
          break;
        default: {
          const unsupportedMode: never = mode;
          throw new Error(`Unsupported search mode: ${unsupportedMode}`);
        }
      }

      // Full-pool reorder, never a truncator: every candidate present before
      // this runs is still present afterward, only reordered. Downstream
      // truncation/min_score/type-tags filtering in tools/index.ts is
      // unaffected in mechanism (add-mmr-diversity-reranking).
      results = wantVectors && results.length > 1
        ? this.mmrRerank(results, this.config.search.mmr.lambda)
        : results;

      if (includeArchived) {
        const archivedMatches = this.storage.sqlite
          .searchArchived(namespace, query, limit)
          .map(archiveRecordToSearchResult);
        results = [...results, ...archivedMatches];
      }

      // Strip the transient MMR scratch vector before returning so the
      // "never populated in public tool responses" contract on
      // `SearchResult.vector` continues to hold; `undefined` is dropped by
      // `JSON.stringify`. `searchForInject` bypasses this method's return
      // path entirely (calls `hybridSearch` directly), so its callers still
      // see `vector` populated.
      for (const r of results) {
        r.vector = undefined;
      }

      return results;
    } finally {
      this.metrics?.recordHistogram('search_total_ms', Date.now() - start);
    }
  }

  private async semanticSearch(
    query: string,
    namespace: string,
    collection: string | undefined,
    limit: number,
    filter?: RecallFilter,
    // Mirrors `hybridSearch`'s `withVectors` flag (add-mmr-diversity-reranking):
    // when true, requests raw vectors from Qdrant so `search()` can MMR-rerank
    // the pool. Default false so every pre-existing caller is unaffected.
    withVectors = false,
  ): Promise<SearchResult[]> {
    let vectors: number[][];
    let variantCount: number;
    try {
      ({ vectors, variantCount } = await this.embedQueryVariants(query));
    } catch {
      throw embeddingUnavailable('Cannot perform semantic search: embedding provider unavailable');
    }

    this.metrics?.recordHistogram('search_query_expansion_variant_count', variantCount);

    let merged: Array<{ id: string; score: number; payload: Record<string, unknown>; vector?: number[] }>;
    try {
      const qdrantFilter: (RecallFilter & { withVector?: boolean }) | undefined = withVectors
        ? { ...(filter ?? {}), withVector: true }
        : filter;
      const perVariant = await Promise.all(vectors.map(vector =>
        qdrantFilter
          ? this.storage.qdrant.search(namespace, collection, vector, limit, qdrantFilter)
          : this.storage.qdrant.search(namespace, collection, vector, limit),
      ));
      merged = this.mergeVariantResults(perVariant, limit);
    } catch (err) {
      throw internal(`Semantic search failed: vector store unavailable — ${(err as Error).message}`);
    }

    return this.buildSearchResults(
      merged.map(r => ({
        id: r.id,
        score: r.score,
        semantic_score: r.score,
        qdrantPayload: r.payload,
        vector: r.vector,
      })),
    );
  }

  private fulltextSearch(
    query: string,
    namespace: string,
    collection: string | undefined,
    limit: number,
    filter?: RecallFilter,
  ): SearchResult[] {
    const ftsResults = filter
      ? this.storage.sqlite.fullTextSearch(namespace, query, limit, collection, filter)
      : this.storage.sqlite.fullTextSearch(namespace, query, limit, collection);
    return this.buildSearchResults(
      ftsResults.map(r => {
        const normalizedScore = Math.min(1, Math.abs(r.rank) / 10);
        return {
          id: r.id,
          score: normalizedScore,
          fulltext_score: normalizedScore,
        };
      }),
    );
  }

  private async hybridSearch(
    query: string,
    namespace: string,
    collection: string | undefined,
    limit: number,
    signal?: { degraded?: boolean },
    filter?: RecallFilter,
    // Relevance-conditioned inject's near-duplicate suppression needs the raw
    // vectors behind the semantic leg; every other caller leaves this false, so
    // `storage.qdrant.search` gets no `withVector` option and behaves exactly
    // as before this parameter existed.
    withVectors = false,
  ): Promise<SearchResult[]> {
    const weights = this.config.search.hybrid_weights;

    // Run both searches in parallel where possible
    let semanticItems: Array<{ id: string; score: number; vector?: number[] }> = [];
    const fulltextItems = filter
      ? this.storage.sqlite.fullTextSearch(namespace, query, limit * 2, collection, filter)
      : this.storage.sqlite.fullTextSearch(namespace, query, limit * 2, collection);

    try {
      const { vectors, variantCount } = await this.embedQueryVariants(query);
      this.metrics?.recordHistogram('search_query_expansion_variant_count', variantCount);
      // Preserve exact call arity for every pre-existing caller: `filter` is
      // passed through untouched (same reference, no `withVector` key added)
      // unless vectors were actually requested, and the options argument is
      // omitted entirely (not even `undefined`) when neither is needed.
      const qdrantFilter: (RecallFilter & { withVector?: boolean }) | undefined = withVectors
        ? { ...(filter ?? {}), withVector: true }
        : filter;
      const perVariant = await Promise.all(vectors.map(vector =>
        qdrantFilter
          ? this.storage.qdrant.search(namespace, collection, vector, limit * 2, qdrantFilter)
          : this.storage.qdrant.search(namespace, collection, vector, limit * 2),
      ));
      semanticItems = this.mergeVariantResults(
        perVariant.map(results => results.map(r => ({ id: r.id, score: r.score, vector: r.vector }))),
        limit * 2,
      );
    } catch (err) {
      // Embedding/vector store unavailable: degrade to fulltext-only, but make the
      // degradation observable instead of silent (dependency outages are signal in
      // this project). Semantic mode raises EMBEDDING_UNAVAILABLE; hybrid stays
      // graceful but emits a metric + warning so operators can see it.
      this.metrics?.incCounter('search_embedding_degraded');
      this.logger?.warn({
        event: 'embedding_degraded',
        degraded: 'fulltext_only',
        message: (err as Error).message,
      });
      if (signal) signal.degraded = true;
    }

    // Build RRF fusion
    const itemMap = new Map<string, RankedItem>();

    semanticItems.forEach((item, idx) => {
      const existing = itemMap.get(item.id) ?? { id: item.id };
      existing.semanticRank = idx + 1;
      existing.semanticScore = item.score;
      existing.vector = item.vector;
      itemMap.set(item.id, existing);
    });

    fulltextItems.forEach((item, idx) => {
      const existing = itemMap.get(item.id) ?? { id: item.id };
      existing.fulltextRank = idx + 1;
      existing.fulltextScore = Math.min(1, Math.abs(item.rank) / 10);
      itemMap.set(item.id, existing);
    });

    // Compute RRF scores
    const scored = Array.from(itemMap.values()).map(item => {
      const semanticRrf = item.semanticRank
        ? weights.semantic / (RRF_K + item.semanticRank)
        : 0;
      const fulltextRrf = item.fulltextRank
        ? weights.fulltext / (RRF_K + item.fulltextRank)
        : 0;
      return {
        ...item,
        rrfScore: semanticRrf + fulltextRrf,
      };
    });

    scored.sort((a, b) => b.rrfScore - a.rrfScore);

    return this.buildSearchResults(
      scored.slice(0, limit).map(item => ({
        id: item.id,
        score: item.rrfScore,
        semantic_score: item.semanticScore,
        fulltext_score: item.fulltextScore,
        vector: item.vector,
      })),
    );
  }

  /**
   * Hybrid search variant for relevance-conditioned inject
   * (`memory://inject/{hint}`): identical composite/RRF ranking, expiry
   * filtering, and access recording to a normal hybrid search, but also
   * requests vectors from the semantic leg so the caller can suppress
   * near-duplicate memories before injecting them. Candidates that only
   * matched via fulltext carry no vector and are therefore never suppressed.
   */
  async searchForInject(
    hint: string,
    namespace: string,
    limit: number,
    signal?: { degraded?: boolean },
  ): Promise<SearchResult[]> {
    return this.hybridSearch(hint, namespace, undefined, limit, signal, undefined, true);
  }

  // Composite ranking prior: final = relevance × (w_base + w_imp·importance +
  // w_acc·log1p(access_count)/log1p(access_norm)) × exp(-λ_tier·age_days).
  // `w_base` is a fixed constant (not configurable) so the prior for a
  // never-accessed, default-importance memory stays close to 1 by design; only
  // the auxiliary weights and decay rates are operator-tunable. Age is measured
  // from `updated_at` so an UPDATE resets a memory's effective age, consistent
  // with the merge semantics elsewhere in the pipeline.
  private static readonly RANKING_W_BASE = 1.0;
  private static readonly MS_PER_DAY = 86400000;

  private compositeScore(
    relevance: number,
    mem: Pick<MemoryRecord, 'importance' | 'access_count' | 'retention_tier' | 'updated_at'>,
    now: Date,
  ): number {
    const ranking = this.config.search.ranking;
    if (!ranking.enabled) return relevance;

    const prior =
      SearchService.RANKING_W_BASE +
      ranking.w_importance * mem.importance +
      ranking.w_access * (Math.log1p(mem.access_count) / Math.log1p(ranking.access_norm));

    const ageDays = Math.max(0, now.getTime() - new Date(mem.updated_at).getTime()) / SearchService.MS_PER_DAY;
    const lambda = ranking.decay_per_day[mem.retention_tier];
    const decay = Math.exp(-lambda * ageDays);

    return relevance * prior * decay;
  }

  // Maximal Marginal Relevance: greedily reorders `results` trading relevance
  // for diversity among already-selected candidates (add-mmr-diversity-
  // reranking). Full-pool reorder, never a truncator — every input result is
  // returned, same length, only reordered. No-op for pools too small to
  // diversify. `.score` is min-max normalized across the pool first so
  // `lambda` means the same thing regardless of whether it came from
  // cosine-scale semantic ranking or RRF-scale hybrid ranking; a pool with no
  // score spread normalizes to `1` for every candidate, so only diversity
  // differentiates ties. Candidates/comparisons missing a vector contribute
  // `0` similarity — never penalized, never able to penalize others.
  private mmrRerank(results: SearchResult[], lambda: number): SearchResult[] {
    if (results.length <= 1) return results;

    const scores = results.map(r => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const spread = max - min;
    const normScore = new Map<SearchResult, number>(
      results.map(r => [r, spread === 0 ? 1 : (r.score - min) / spread]),
    );

    const remaining = [...results];
    const selected: SearchResult[] = [];

    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestValue = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i]!;
        const relevance = normScore.get(candidate)!;
        let maxSim = 0;
        if (candidate.vector) {
          for (const sel of selected) {
            if (!sel.vector) continue;
            const sim = cosineSimilarity(candidate.vector, sel.vector);
            if (sim > maxSim) maxSim = sim;
          }
        }
        const value = lambda * relevance - (1 - lambda) * maxSim;
        if (value > bestValue) {
          bestValue = value;
          bestIdx = i;
        }
      }
      const [chosen] = remaining.splice(bestIdx, 1);
      selected.push(chosen!);
    }

    return selected;
  }

  private buildSearchResults(
    ranked: Array<{ id: string; score: number; semantic_score?: number; fulltext_score?: number; qdrantPayload?: Record<string, unknown>; vector?: number[] }>,
  ): SearchResult[] {
    const now = new Date();
    const nowIso = now.toISOString();
    const memories = this.storage.sqlite.getMemoriesByIds(ranked.map(item => item.id));
    const memoryMap = new Map(memories.map(mem => [mem.id, mem]));
    const accessUpdates: AccessUpdate[] = [];
    const searchResults: SearchResult[] = [];

    for (const item of ranked) {
      const mem = memoryMap.get(item.id);

      // Fallback to Qdrant payload if SQLite miss (cross-device memory)
      if (!mem) {
        if (item.qdrantPayload) {
          const result = this.buildResultFromQdrantPayload(item, item.qdrantPayload, nowIso);
          if (result) searchResults.push(result);
        }
        continue;
      }

      if (this.lifecycle.isExpired(mem.expires_at, now)) continue;

      const adjustedScore = this.compositeScore(item.score, mem, now);

      accessUpdates.push(this.buildAccessUpdate(mem, now, nowIso));
      searchResults.push({
        id: mem.id,
        content: mem.content,
        summary: mem.summary,
        type: mem.type,
        tags: mem.tags,
        score: adjustedScore,
        semantic_score: item.semantic_score,
        fulltext_score: item.fulltext_score,
        retention_tier: mem.retention_tier,
        expires_at: mem.expires_at,
        expiring_soon: this.lifecycle.isExpiringSoon(mem.expires_at, now),
        device_id: mem.device_id ?? null,
        created_at: mem.created_at,
        last_accessed: nowIso,
        // `undefined` for every caller except `searchForInject`; JSON.stringify
        // drops undefined-valued keys, so this never appears in tool responses.
        vector: item.vector,
      });
    }

    // Composite scoring can reorder relative to the incoming relevance order
    // (a lower-relevance, high-importance/high-access/fresh memory can now
    // outrank a higher-relevance stale one), so results must be re-sorted here
    // rather than trusting the order the mode implementations produced.
    searchResults.sort((a, b) => b.score - a.score);

    if (accessUpdates.length > 0) {
      this.storage.sqlite.recordAccessBatch(accessUpdates);
      this.storage.sqlite.scheduleDeferredFlush();
    }

    return searchResults;
  }

  // Validates/narrows an untrusted Qdrant payload before constructing a
  // SearchResult for the cross-device fallback branch (a ranked id present in
  // Qdrant but with no local SQLite row). `content` has no safe default — a
  // payload missing it is treated as unusable and dropped. Every other field
  // falls back to the same defaults the previous unchecked-cast code used.
  private buildResultFromQdrantPayload(
    item: { id: string; score: number; semantic_score?: number; fulltext_score?: number },
    payload: Record<string, unknown>,
    nowIso: string,
  ): SearchResult | null {
    const content = narrowString(payload.content);
    if (content === undefined) return null;
    return {
      id: item.id,
      content,
      summary: narrowString(payload.summary) ?? '',
      type: isMemoryType(payload.type) ? payload.type : 'semantic',
      tags: isStringArray(payload.tags) ? payload.tags : [],
      score: item.score,
      semantic_score: item.semantic_score,
      fulltext_score: item.fulltext_score,
      retention_tier: isRetentionTier(payload.retention_tier) ? payload.retention_tier : 'T2',
      expires_at: null,
      expiring_soon: false,
      device_id: narrowString(payload.device_id) ?? null,
      created_at: narrowString(payload.created_at) ?? nowIso,
      last_accessed: nowIso,
    };
  }

  private buildAccessUpdate(
    mem: Pick<MemoryRecord, 'id' | 'namespace' | 'access_count' | 'retention_tier' | 'expires_at'>,
    now: Date,
    nowIso: string,
  ): AccessUpdate {
    const nextAccessCount = mem.access_count + 1;
    const promotedTier = this.lifecycle.shouldPromote(mem.retention_tier, nextAccessCount) ?? mem.retention_tier;
    // Tri-state: a string sets a new expiry, `null` clears it, `undefined` preserves
    // the existing deadline (e.g. non-sliding mode with an unchanged tier).
    const nextExpiry = this.lifecycle.nextExpiryForAccess(mem.retention_tier, promotedTier, now);
    const nextReviewDue = promotedTier === 'T1'
      ? this.lifecycle.computeExpiry('T1', now)
      : undefined;

    if (promotedTier !== mem.retention_tier) {
      // Promotion is a distinct lifecycle transition, not a generic content
      // write, so it gets its own structured audit event rather than being
      // folded into the ADD/UPDATE/FORGET log.
      this.storage.logAudit('PROMOTE', mem.id, mem.namespace, 'system', {
        flush: false,
        details: {
          memory_id: mem.id,
          prior_tier: mem.retention_tier,
          new_tier: promotedTier,
          actor: 'system',
          timestamp: nowIso,
          action: 'promote',
        },
      });
    }

    return {
      id: mem.id,
      access_count: nextAccessCount,
      last_accessed: nowIso,
      expires_at: nextExpiry,
      retention_tier: promotedTier !== mem.retention_tier ? promotedTier : undefined,
      review_due: nextReviewDue,
    };
  }
}
