import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { SearchMode, SearchResult } from '../domain/types.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';
import { embeddingUnavailable, internal } from '../errors/index.js';

const RRF_K = 60;

interface RankedItem {
  id: string;
  semanticRank?: number;
  fulltextRank?: number;
  semanticScore?: number;
  fulltextScore?: number;
}

export class SearchService {
  private lifecycle: MemoryLifecycleService;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
  ) {
    this.lifecycle = new MemoryLifecycleService(config);
  }

  async search(
    query: string,
    namespace: string,
    collection: string | undefined,
    mode: SearchMode,
    limit: number,
  ): Promise<SearchResult[]> {
    switch (mode) {
      case 'semantic':
        return this.semanticSearch(query, namespace, collection, limit);
      case 'fulltext':
        return this.fulltextSearch(query, namespace, collection, limit);
      case 'hybrid':
        return this.hybridSearch(query, namespace, collection, limit);
    }
  }

  private async semanticSearch(
    query: string,
    namespace: string,
    collection: string | undefined,
    limit: number,
  ): Promise<SearchResult[]> {
    let vector: number[];
    try {
      vector = await this.embedding.embed(query);
    } catch {
      throw embeddingUnavailable('Cannot perform semantic search: embedding provider unavailable');
    }

    let results: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
    try {
      results = await this.storage.qdrant.search(
        namespace, collection, vector, limit,
      );
    } catch (err) {
      throw internal(`Semantic search failed: vector store unavailable — ${(err as Error).message}`);
    }

    return this.buildSearchResults(
      results.map(r => ({
        id: r.id,
        score: r.score,
        semantic_score: r.score,
      })),
    );
  }

  private fulltextSearch(
    query: string,
    namespace: string,
    collection: string | undefined,
    limit: number,
  ): SearchResult[] {
    const ftsResults = this.storage.sqlite.fullTextSearch(namespace, query, limit, collection);
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
  ): Promise<SearchResult[]> {
    const weights = this.config.search.hybrid_weights;

    // Run both searches in parallel where possible
    let semanticItems: Array<{ id: string; score: number }> = [];
    const fulltextItems = this.storage.sqlite.fullTextSearch(namespace, query, limit * 2, collection);

    try {
      const vector = await this.embedding.embed(query);
      const qdrantResults = await this.storage.qdrant.search(
        namespace, collection, vector, limit * 2,
      );
      semanticItems = qdrantResults.map(r => ({ id: r.id, score: r.score }));
    } catch {
      // Embedding unavailable: fall back to fulltext only
    }

    // Build RRF fusion
    const itemMap = new Map<string, RankedItem>();

    semanticItems.forEach((item, idx) => {
      const existing = itemMap.get(item.id) ?? { id: item.id };
      existing.semanticRank = idx + 1;
      existing.semanticScore = item.score;
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
      })),
      { boostT0: true },
    );
  }

  private buildSearchResults(
    ranked: Array<{ id: string; score: number; semantic_score?: number; fulltext_score?: number }>,
    options?: { boostT0?: boolean },
  ): SearchResult[] {
    const now = new Date();
    const nowIso = now.toISOString();
    const memories = typeof (this.storage.sqlite as any).getMemoriesByIds === 'function'
      ? this.storage.sqlite.getMemoriesByIds(ranked.map(item => item.id))
      : ranked
        .map(item => this.storage.sqlite.getMemoryById(item.id))
        .filter(Boolean);
    const memoryMap = new Map(memories.map((mem: any) => [mem.id, mem]));
    const accessUpdates: Array<{
      id: string;
      access_count: number;
      last_accessed: string;
      expires_at?: string | null;
      retention_tier?: SearchResult['retention_tier'];
      review_due?: string | null;
    }> = [];
    const searchResults: SearchResult[] = [];

    for (const item of ranked) {
      const mem = memoryMap.get(item.id);
      if (!mem) continue;
      if (this.lifecycle.isExpired(mem.expires_at, now)) continue;

      let adjustedScore = item.score;
      if (options?.boostT0 && mem.retention_tier === 'T0') {
        adjustedScore += 0.1;
      }

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
        created_at: mem.created_at,
        last_accessed: nowIso,
      });
    }

    if (accessUpdates.length > 0) {
      if (typeof (this.storage.sqlite as any).recordAccessBatch === 'function') {
        this.storage.sqlite.recordAccessBatch(accessUpdates);
      } else if (typeof (this.storage.sqlite as any).recordAccess === 'function') {
        for (const update of accessUpdates) {
          this.storage.sqlite.recordAccess(
            update.id,
            update.access_count,
            update.last_accessed,
            update.expires_at,
            update.retention_tier,
            update.review_due,
          );
        }
      } else {
        for (const update of accessUpdates) {
          this.storage.sqlite.touchMemory(update.id);
        }
      }
      this.storage.sqlite.scheduleDeferredFlush();
    }

    return searchResults;
  }

  private buildAccessUpdate(
    mem: { id: string; access_count: number; retention_tier: SearchResult['retention_tier']; expires_at: string | null },
    now: Date,
    nowIso: string,
  ): {
    id: string;
    access_count: number;
    last_accessed: string;
    expires_at?: string | null;
    retention_tier?: SearchResult['retention_tier'];
    review_due?: string | null;
  } {
    const nextAccessCount = mem.access_count + 1;
    const promotedTier = this.lifecycle.shouldPromote(mem.retention_tier, nextAccessCount) ?? mem.retention_tier;
    const nextExpiry = this.lifecycle.extendExpiry(promotedTier, now);
    const nextReviewDue = promotedTier === 'T1'
      ? this.lifecycle.computeExpiry('T1', now)
      : undefined;
    return {
      id: mem.id,
      access_count: nextAccessCount,
      last_accessed: nowIso,
      expires_at: nextExpiry === null ? null : nextExpiry,
      retention_tier: promotedTier !== mem.retention_tier ? promotedTier : undefined,
      review_due: nextReviewDue,
    };
  }
}
