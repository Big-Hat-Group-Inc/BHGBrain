import { QdrantClient } from '@qdrant/js-client-rest';
import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { CircuitOpenError } from '../resilience/index.js';
import { internal } from '../errors/index.js';
import type { RecallFilter } from '../domain/types.js';

const COLLECTION_PREFIX = 'bhgbrain_';

// Narrows Qdrant's `ScoredPoint.vector` (unnamed dense vector | named vectors |
// sparse | null | undefined per the client's OpenAPI types) down to the plain
// `number[]` this codebase's dense, unnamed vectors always are. Named/sparse
// shapes are foreign to this project's collections, so they narrow to
// `undefined` rather than being guessed at.
function extractDenseVector(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every(v => typeof v === 'number')
    ? (value as number[])
    : undefined;
}

export class QdrantStore {
  private client: QdrantClient;
  private dimensions: number;

  constructor(
    private config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly logger?: { warn: (obj: Record<string, unknown>) => void },
  ) {
    this.dimensions = config.embedding.dimensions;

    if (config.qdrant.mode === 'external' && config.qdrant.external_url) {
      const apiKey = config.qdrant.api_key_env
        ? process.env[config.qdrant.api_key_env]
        : undefined;
      this.client = new QdrantClient({
        url: config.qdrant.external_url,
        apiKey,
      });
    } else {
      this.client = new QdrantClient({
        url: 'http://localhost:6333',
      });
    }
  }

  private collectionName(namespace: string, collection: string): string {
    return `${COLLECTION_PREFIX}${namespace}_${collection}`;
  }

  async ensureCollection(namespace: string, collection: string): Promise<void> {
    const name = this.collectionName(namespace, collection);
    try {
      await this.client.getCollection(name);
    } catch {
      await this.client.createCollection(name, {
        vectors: {
          size: this.dimensions,
          distance: 'Cosine',
        },
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'namespace',
        field_schema: 'keyword',
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'type',
        field_schema: 'keyword',
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'retention_tier',
        field_schema: 'keyword',
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'decay_eligible',
        field_schema: 'bool',
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'expires_at',
        field_schema: 'integer',
      });
    }

    // Ensured unconditionally (not just on first create) so that collections
    // created before device provenance shipped — the exact post-upgrade,
    // multi-device Qdrant Cloud scenario this feature targets — still get the
    // index. Idempotent: a second call against an already-indexed collection
    // is a tolerated no-op.
    await this.ensureDeviceIdIndex(name);

    // Same retroactive-indexing rationale as `ensureDeviceIdIndex`: collections
    // created before add-time-scoped-recall shipped still get the `created_at`
    // datetime index so `after`/`before` range filters run indexed rather than
    // linearly scanned. Unindexed range filtering is still correct (Qdrant
    // filters on unindexed fields, just slower), so this is a performance
    // addition, not a correctness dependency.
    await this.ensureCreatedAtIndex(name);
  }

  private async ensureDeviceIdIndex(name: string): Promise<void> {
    try {
      await this.client.createPayloadIndex(name, {
        field_name: 'device_id',
        field_schema: 'keyword',
      });
    } catch (err) {
      if (this.isAlreadyExistsError(err)) {
        return;
      }
      throw err;
    }
  }

  private async ensureCreatedAtIndex(name: string): Promise<void> {
    try {
      await this.client.createPayloadIndex(name, {
        field_name: 'created_at',
        field_schema: 'datetime',
      });
    } catch (err) {
      if (this.isAlreadyExistsError(err)) {
        return;
      }
      throw err;
    }
  }

  async upsert(
    namespace: string,
    collection: string,
    id: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.executeWithBreaker(async () => {
      const name = this.collectionName(namespace, collection);
      await this.ensureCollection(namespace, collection);
      await this.client.upsert(name, {
        wait: true,
        points: [{
          id,
          vector,
          payload: { ...payload, namespace },
        }],
      });
    });
  }

  async delete(namespace: string, collection: string, id: string): Promise<void> {
    await this.executeWithBreaker(async () => {
      const name = this.collectionName(namespace, collection);
      try {
        await this.client.delete(name, {
          wait: true,
          points: [id],
        });
      } catch (err) {
        if (this.isNotFoundError(err)) {
          return;
        }
        throw err;
      }
    });
  }

  async deleteMany(namespace: string, collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const name = this.collectionName(namespace, collection);
    try {
      await this.client.delete(name, {
        wait: true,
        points: ids,
      });
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return;
      }
      throw err;
    }
  }

  async search(
    namespace: string,
    collection: string | undefined,
    vector: number[],
    limit: number,
    // `withVector`: relevance-conditioned inject's near-duplicate suppression
    // needs the raw vectors behind the semantic leg's results; every other
    // caller omits it, so `with_vector` stays `false` (its pre-existing
    // implicit default) and behavior is unchanged for them.
    filters?: RecallFilter & { minScore?: number; withVector?: boolean },
  ): Promise<Array<{ id: string; score: number; payload: Record<string, unknown>; vector?: number[] }>> {
    const must: Array<Record<string, unknown>> = [
      { key: 'namespace', match: { value: namespace } },
    ];
    if (filters?.type) {
      must.push({ key: 'type', match: { value: filters.type } });
    }
    if (filters?.tags && filters.tags.length > 0) {
      // Match-any: a point matches if its `tags` payload array contains at
      // least one of the requested tags (mirrors recall's pre-existing OR
      // semantics over provided tags).
      must.push({ key: 'tags', match: { any: filters.tags } });
    }
    if (filters?.after !== undefined || filters?.before !== undefined) {
      // Native RFC 3339 datetime range filter on the `created_at` payload
      // field (ISO 8601 string, unmodified since `toQdrantPayload`'s
      // inception — see add-time-scoped-recall). Omitted entirely when
      // neither bound is requested, so unfiltered calls are unchanged.
      must.push({ key: 'created_at', range: { gte: filters.after, lte: filters.before } });
    }
    must.push({
      should: [
        { key: 'decay_eligible', match: { value: false } },
        { key: 'expires_at', range: { gte: Math.floor(Date.now() / 1000) } },
        { is_empty: { key: 'expires_at' } },
      ],
    });

    // When no collection is specified, search every collection in the namespace
    // rather than silently defaulting to `general` (which hid all other
    // collections). The payload `namespace` filter keeps results correct even if
    // the prefix match is broad, so over-inclusion is safe.
    let targets: string[];
    if (collection !== undefined) {
      targets = [this.collectionName(namespace, collection)];
    } else {
      const all = await this.listAllCollections();
      const prefix = `${COLLECTION_PREFIX}${namespace}_`;
      targets = all.filter(n => n.startsWith(prefix));
      if (targets.length === 0) return [];
    }

    const perCollection = await Promise.all(targets.map(name =>
      this.executeWithBreaker(() => this.client.query(name, {
        query: vector,
        limit,
        filter: must.length > 0 ? { must } : undefined,
        score_threshold: filters?.minScore,
        with_payload: true,
        with_vector: filters?.withVector ?? false,
      })).then(response => response.points).catch((err: unknown) => {
        // A target collection that no longer exists simply contributes no results.
        if (this.isNotFoundError(err)) return [];
        throw err;
      }),
    ));

    const merged = perCollection.flat().map(r => ({
      id: r.id as string,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      vector: extractDenseVector(r.vector),
    }));
    // Top-K across the merged candidate set when fanning out over collections.
    if (targets.length > 1) {
      merged.sort((a, b) => b.score - a.score);
      return merged.slice(0, limit);
    }
    return merged;
  }

  async searchSimilar(
    namespace: string,
    collection: string,
    vector: number[],
    topK: number,
  ): Promise<Array<{ id: string; score: number }>> {
    const name = this.collectionName(namespace, collection);
    try {
      const response = await this.executeWithBreaker(() => this.client.query(name, {
        query: vector,
        limit: topK,
        filter: {
          must: [{ key: 'namespace', match: { value: namespace } }],
        },
        with_payload: false,
      }));
      return response.points.map(r => ({ id: r.id as string, score: r.score }));
    } catch (err) {
      // A collection that has never been written to (namespace/collection pair
      // with no prior memories) simply has no similar vectors. Any other
      // failure (transport, auth, a removed client method, an open circuit
      // breaker) must not be presented to the write pipeline as "no near
      // duplicates" - it is logged and propagated so the caller can
      // distinguish an empty result from a failed similarity check instead
      // of silently proceeding as a novel write.
      if (this.isNotFoundError(err)) {
        return [];
      }
      this.logger?.warn({
        event: 'similarity_search_failed',
        namespace,
        collection,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * Per-point ANN neighbor discovery for duplicate-cluster consolidation
   * (`consolidate list`, see design.md "Neighbor discovery via Qdrant's own
   * per-point ANN query"). Passes an existing point's id as the query
   * instead of a raw vector — Qdrant's Query API resolves the point's stored
   * vector server-side, so no vector is ever fetched or held client-side.
   * Requests one extra result (`topK + 1`) because Qdrant returns the query
   * point itself at score 1.0 when querying by id, then filters that self-hit
   * out of the response. Bounded (`O(topK)` per call) rather than a full
   * pairwise scan — see design.md Decisions.
   */
  async findNeighborsById(
    namespace: string,
    collection: string,
    pointId: string,
    topK: number,
    minScore: number,
  ): Promise<Array<{ id: string; score: number }>> {
    const name = this.collectionName(namespace, collection);
    try {
      const response = await this.executeWithBreaker(() => this.client.query(name, {
        query: pointId,
        limit: topK + 1,
        filter: {
          must: [{ key: 'namespace', match: { value: namespace } }],
        },
        score_threshold: minScore,
        with_payload: false,
      }));
      return response.points
        .filter(r => r.id !== pointId)
        .map(r => ({ id: r.id as string, score: r.score }));
    } catch (err) {
      // A collection that has never been written to yields no neighbors, not
      // a thrown error — same convention as `searchSimilar`.
      if (this.isNotFoundError(err)) {
        return [];
      }
      this.logger?.warn({
        event: 'neighbor_discovery_failed',
        namespace,
        collection,
        point_id: pointId,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async healthCheck(): Promise<boolean> {
    // Probe the retrieval path itself (the same `query` call `search`/
    // `searchSimilar` use), not just connectivity: a reachable server that
    // rejects or cannot execute queries (removed client method, incompatible
    // request shape, server-side rejection) must not report healthy just
    // because `getCollections()` succeeds. The probe is bounded (limit 1)
    // and skips payload hydration so polling stays cheap and side-effect
    // free. It targets the default namespace/collection so a fresh install
    // with no data yet still exercises the call; a missing collection or an
    // empty result set are both healthy - only a raised failure is not.
    const name = this.collectionName(this.config.defaults.namespace, this.config.defaults.collection);
    try {
      await this.client.query(name, {
        query: new Array(this.dimensions).fill(0),
        limit: 1,
        with_payload: false,
      });
      return true;
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return true;
      }
      throw err;
    }
  }

  async getCollectionInfo(namespace: string, collection: string): Promise<{ points_count: number } | null> {
    const name = this.collectionName(namespace, collection);
    try {
      const info = await this.client.getCollection(name);
      return { points_count: info.points_count ?? 0 };
    } catch {
      return null;
    }
  }

  /**
   * Nudges Qdrant's segment optimizer to reclaim space in a collection whose
   * deleted-vector ratio has crossed the configured threshold. Qdrant has no
   * "compact now" endpoint; re-applying `optimizers_config.deleted_threshold`
   * via `updateCollection` is the documented way to make the optimizer
   * re-evaluate deleted segments on its next pass. A missing collection is a
   * tolerated no-op (nothing to compact).
   */
  async compact(namespace: string, collection: string, deletedThreshold: number): Promise<void> {
    await this.executeWithBreaker(async () => {
      const name = this.collectionName(namespace, collection);
      try {
        await this.client.updateCollection(name, {
          optimizers_config: { deleted_threshold: deletedThreshold },
        });
      } catch (err) {
        if (this.isNotFoundError(err)) {
          return;
        }
        throw err;
      }
    });
  }

  async deleteCollection(namespace: string, collection: string): Promise<void> {
    const name = this.collectionName(namespace, collection);
    try {
      await this.client.deleteCollection(name);
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return;
      }
      throw err;
    }
  }

  async createSnapshot(namespace: string, collection: string): Promise<string | null> {
    const name = this.collectionName(namespace, collection);
    try {
      const snapshot = await this.client.createSnapshot(name);
      return snapshot?.name ?? null;
    } catch {
      return null;
    }
  }

  async listAllCollections(): Promise<string[]> {
    const response = await this.client.getCollections();
    return response.collections
      .map(c => c.name)
      .filter(name => name.startsWith(COLLECTION_PREFIX));
  }

  async scrollAll(
    collectionName: string,
    batchSize = 100,
    // Distillation's clustering pass (add-memory-distillation) needs the raw
    // vectors behind every point in a collection to compute cosine similarity
    // in memory; every pre-existing caller omits this, so `with_vector` stays
    // `false` (its original hardcoded value) and their behavior is unchanged.
    withVector = false,
  ): Promise<Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }>> {
    const allPoints: Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }> = [];
    let offset: string | number | undefined = undefined;

    while (true) {
      const response = await this.client.scroll(collectionName, {
        limit: batchSize,
        offset,
        with_payload: true,
        with_vector: withVector,
      });

      for (const point of response.points) {
        allPoints.push({
          id: point.id as string,
          payload: (point.payload ?? {}) as Record<string, unknown>,
          vector: withVector ? extractDenseVector(point.vector) : undefined,
        });
      }

      if (!response.next_page_offset) break;
      offset = response.next_page_offset as string | number | undefined;
    }

    return allPoints;
  }

  /**
   * `scrollAll` scoped to one namespace/collection, resolving the internal
   * prefixed collection name so callers (e.g. `DistillationService`'s
   * clustering pass) never need to duplicate `collectionName`'s prefix
   * convention. A collection that has never been written to simply yields no
   * points, same convention as `searchSimilar`/`findNeighborsById`.
   */
  async scrollCollection(
    namespace: string,
    collection: string,
    batchSize = 100,
    withVector = false,
  ): Promise<Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }>> {
    const name = this.collectionName(namespace, collection);
    try {
      return await this.scrollAll(name, batchSize, withVector);
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return [];
      }
      throw err;
    }
  }

  private isNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const maybeErr = err as { status?: number; response?: { status?: number }; message?: string };
    const status = maybeErr.status ?? maybeErr.response?.status;
    if (status === 404) return true;
    const message = maybeErr.message?.toLowerCase() ?? '';
    return message.includes('not found') || message.includes('does not exist');
  }

  private isAlreadyExistsError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const maybeErr = err as { status?: number; response?: { status?: number }; message?: string };
    const status = maybeErr.status ?? maybeErr.response?.status;
    if (status === 409) return true;
    const message = maybeErr.message?.toLowerCase() ?? '';
    return message.includes('already exists') || message.includes('conflict');
  }

  private async executeWithBreaker<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.breaker) {
      return fn();
    }

    try {
      return await this.breaker.execute(fn);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw internal('Qdrant circuit breaker is open');
      }
      throw error;
    }
  }

  async clearManagedCollections(): Promise<number> {
    const collections = await this.executeWithBreaker(() => this.client.getCollections());
    const managedNames = (collections.collections ?? [])
      .map(collection => collection.name)
      .filter((name): name is string => typeof name === 'string' && name.startsWith(COLLECTION_PREFIX));

    for (const name of managedNames) {
      try {
        await this.executeWithBreaker(() => this.client.deleteCollection(name));
      } catch (err) {
        if (this.isNotFoundError(err)) {
          continue;
        }
        throw err;
      }
    }

    return managedNames.length;
  }
}
