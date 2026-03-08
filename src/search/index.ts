import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { SearchMode, SearchResult } from '../domain/types.js';
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
  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
  ) {}

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

    const searchResults: SearchResult[] = [];
    for (const r of results) {
      const mem = this.storage.sqlite.getMemoryById(r.id);
      if (!mem) continue;
      this.storage.sqlite.touchMemory(r.id);
      searchResults.push({
        id: mem.id,
        content: mem.content,
        summary: mem.summary,
        type: mem.type,
        tags: mem.tags,
        score: r.score,
        semantic_score: r.score,
        created_at: mem.created_at,
        last_accessed: mem.last_accessed,
      });
    }
    this.storage.sqlite.scheduleDeferredFlush();
    return searchResults;
  }

  private fulltextSearch(
    query: string,
    namespace: string,
    collection: string | undefined,
    limit: number,
  ): SearchResult[] {
    const ftsResults = this.storage.sqlite.fullTextSearch(namespace, query, limit, collection);
    const searchResults: SearchResult[] = [];
    for (const r of ftsResults) {
      const mem = this.storage.sqlite.getMemoryById(r.id);
      if (!mem) continue;
      this.storage.sqlite.touchMemory(r.id);
      const normalizedScore = Math.min(1, Math.abs(r.rank) / 10);
      searchResults.push({
        id: mem.id,
        content: mem.content,
        summary: mem.summary,
        type: mem.type,
        tags: mem.tags,
        score: normalizedScore,
        fulltext_score: normalizedScore,
        created_at: mem.created_at,
        last_accessed: mem.last_accessed,
      });
    }
    this.storage.sqlite.scheduleDeferredFlush();
    return searchResults;
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

    const searchResults: SearchResult[] = [];
    for (const item of scored.slice(0, limit)) {
      const mem = this.storage.sqlite.getMemoryById(item.id);
      if (!mem) continue;
      this.storage.sqlite.touchMemory(item.id);
      searchResults.push({
        id: mem.id,
        content: mem.content,
        summary: mem.summary,
        type: mem.type,
        tags: mem.tags,
        score: item.rrfScore,
        semantic_score: item.semanticScore,
        fulltext_score: item.fulltextScore,
        created_at: mem.created_at,
        last_accessed: mem.last_accessed,
      });
    }
    this.storage.sqlite.scheduleDeferredFlush();
    return searchResults;
  }
}
