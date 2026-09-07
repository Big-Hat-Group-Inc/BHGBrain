import { QdrantClient } from '@qdrant/js-client-rest';
import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { CircuitOpenError } from '../resilience/index.js';
import { internal, invalidInput } from '../errors/index.js';
import type { RecallFilter } from '../domain/types.js';
import type { MetricsCollector } from '../health/metrics.js';

const COLLECTION_PREFIX = 'bhgbrain_';

/** Options accepted by `QdrantStore.scrollAllPages`/`scrollCollectionPages` — see their doc comments. */
export interface ScrollPageOptions {
  batchSize?: number;
  withVector?: boolean;
  /** Restrict the server-side payload projection to these fields; omit for the full payload. */
  payloadFields?: string[];
  /** Resume from a cursor returned by a prior page (see `ScrollPageResult.cursor`). */
  cursor?: string | number;
  /** Polled before each page fetch; once true, scanning stops and the final page reports `cancelled: true`. */
  isCancelled?: () => boolean;
}

/** One page yielded by `QdrantStore.scrollAllPages`/`scrollCollectionPages`. */
export interface ScrollPageResult {
  points: Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }>;
  /** Stable resumption token — pass back via `ScrollPageOptions.cursor` to continue after this page. `null` once exhausted. */
  cursor: string | number | null;
  /** True when this is the last page (no further page remains). */
  done: boolean;
  /** True when this page was cut short by `ScrollPageOptions.isCancelled` rather than reaching the end of the collection. */
  cancelled: boolean;
}

const REQUIRED_PAYLOAD_INDEXES: ReadonlyArray<{ field_name: string; field_schema: 'keyword' | 'bool' | 'integer' | 'datetime' }> = [
  { field_name: 'namespace', field_schema: 'keyword' },
  { field_name: 'type', field_schema: 'keyword' },
  { field_name: 'tags', field_schema: 'keyword' },
  { field_name: 'retention_tier', field_schema: 'keyword' },
  { field_name: 'decay_eligible', field_schema: 'bool' },
  { field_name: 'expires_at', field_schema: 'integer' },
  { field_name: 'device_id', field_schema: 'keyword' },
  { field_name: 'created_at', field_schema: 'datetime' },
];

// Only `.`/`_`/`-` plus alphanumerics may appear in an encoded segment. Raw
// `namespace` (`^[a-zA-Z0-9/-]{1,200}$`) and `collection`/`category.name`
// (`^[a-zA-Z0-9-]{1,100}$`, `CollectionNameSchema`) inputs never contain `.`
// or `_`, so the first bare `_` after an encoded namespace remains
// unambiguously the namespace/collection separator the prefix scan in
// `search()` relies on.
const SAFE_COLLECTION_NAME_SEGMENT = /^[a-zA-Z0-9._-]+$/;

// Qdrant's REST client embeds the collection name as a literal URL path
// segment, so a raw `/` breaks routing instead of producing a clear error
// (see qdrant/qdrant-client#807) — this is why a namespace like "team/project"
// previously made every tool call fail with a bare, unhelpful INTERNAL error.
// `.` is substituted for `/` because Qdrant's server accepts dots in real
// collection names (qdrant/qdrant-web-ui#172 shows
// `create_collection(collection_name: "dotted.name")` succeeding).
//
// This is injective for ANY input, not only input the current schema happens
// to allow (fix-collection-name-collision: `collection`'s schema used to
// allow `.` too, which silently collided `collection: "a.b"` with
// `collection: "a/b"` once both were "encoded"). Every input character
// produces either a 1-character token (anything but `.`/`/`, passed through
// unchanged) or a 2-character token starting with `.` (`..` for a literal
// `.`, `.x` for a `/`) — `.` is never emitted as a 1-character token, so a
// left-to-right scan of the output has exactly one valid parse: on a
// non-`.` character, consume it as a literal 1-character token; on `.`,
// consume it with the next character and decode `..` -> `.` or `.x` -> `/`.
// That greedy parse is a total, deterministic left inverse of this function,
// which makes the function injective regardless of what any schema allows.
function encodeCollectionNameSegment(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '.') out += '..';
    else if (ch === '/') out += '.x';
    else out += ch;
  }
  return out;
}

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
  // bound-qdrant-http-runtime task 1.1/2.1: a dedicated client instance used
  // only by `healthCheck()`, configured with its own (shorter)
  // `qdrant.health_timeout_ms` client-side deadline — deliberately separate
  // from `client`'s `qdrant.operation_timeout_ms` so a stalled dependency
  // fails the health probe quickly without waiting out the longer
  // operational deadline. `healthCheck()` never routes through
  // `executeWithBreaker` (see design.md decision 1), so this client's calls
  // never count toward or get short-circuited by the operational breaker.
  private healthClient: QdrantClient;
  private dimensions: number;

  // cut-embedding-and-qdrant-round-trips: per-instance memo of collections
  // this process has already fully ensured (create-or-get + every payload
  // index), so `upsert` stops paying a `getCollection` + tolerated-409
  // `createPayloadIndex` round trip on every write once a collection is
  // warm. Only ever grows via `ensureCollection` after the *entire* ensure
  // sequence succeeds — a partial failure leaves the name un-memoized so the
  // next call retries the full sequence. Invalidated on `deleteCollection`,
  // `clearManagedCollections`, and a not-found surfaced during `upsert`
  // (collection deleted out from under this process).
  private ensuredCollections = new Set<string>();

  // Short-TTL cache for `listAllCollections`, which namespace-wide `search`
  // calls on every request absent a specific `collection`. TTL (not pure
  // event-invalidation) because other devices can create/delete collections
  // remotely without this process observing it; eagerly invalidated on any
  // local create/delete so this process's own mutations are never stale to
  // itself.
  private static readonly COLLECTION_LIST_TTL_MS = 5000;
  private collectionListCache: { names: string[]; expiresAt: number } | null = null;

  constructor(
    private config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly logger?: { warn: (obj: Record<string, unknown>) => void; info?: (obj: Record<string, unknown>) => void },
    private readonly metrics?: MetricsCollector,
  ) {
    this.dimensions = config.embedding.dimensions;
    // bound-qdrant-http-runtime task 1.1: the client's own `timeout` option
    // (ms) is enforced client-side via AbortController (see
    // @qdrant/js-client-rest's api-client.js) — this is what actually bounds
    // a black-holed/stalled endpoint, unlike the per-request `timeout` field
    // some client methods accept, which is a server-side hint only.
    const operationTimeoutMs = config.qdrant.operation_timeout_ms;
    const healthTimeoutMs = config.qdrant.health_timeout_ms;

    if (config.qdrant.mode === 'external' && config.qdrant.external_url) {
      const apiKey = config.qdrant.api_key_env
        ? process.env[config.qdrant.api_key_env]
        : undefined;
      this.client = new QdrantClient({
        url: config.qdrant.external_url,
        apiKey,
        timeout: operationTimeoutMs,
      });
      this.healthClient = new QdrantClient({
        url: config.qdrant.external_url,
        apiKey,
        timeout: healthTimeoutMs,
        // Skip the constructor's own background compatibility-check request
        // for this second client instance — `client` above already performs
        // it once; a duplicate isn't useful and would itself be an
        // uncounted, unbounded-by-config startup request.
        checkCompatibility: false,
      });
    } else {
      this.client = new QdrantClient({
        url: 'http://localhost:6333',
        timeout: operationTimeoutMs,
      });
      this.healthClient = new QdrantClient({
        url: 'http://localhost:6333',
        timeout: healthTimeoutMs,
        checkCompatibility: false,
      });
    }
  }

  private collectionName(namespace: string, collection: string): string {
    const nsSegment = encodeCollectionNameSegment(namespace);
    const collectionSegment = encodeCollectionNameSegment(collection);
    // Defense in depth: schema-valid input always produces a safe segment
    // today, so this should never fire in practice. It exists to turn any
    // future schema drift or unanticipated character into a clear
    // INVALID_INPUT at the point of failure rather than a Qdrant-side
    // rejection surfacing as a generic INTERNAL error further up the stack.
    if (!SAFE_COLLECTION_NAME_SEGMENT.test(nsSegment) || !SAFE_COLLECTION_NAME_SEGMENT.test(collectionSegment)) {
      throw invalidInput(
        `Namespace "${namespace}" and collection "${collection}" cannot be represented as a Qdrant collection name`,
      );
    }
    return `${COLLECTION_PREFIX}${nsSegment}_${collectionSegment}`;
  }

  async ensureCollection(namespace: string, collection: string): Promise<void> {
    const name = this.collectionName(namespace, collection);
    // cut-embedding-and-qdrant-round-trips: once this process has fully
    // ensured a collection, every subsequent write to it is a no-op here —
    // no `getCollection` round trip, no tolerated-409 `createPayloadIndex`
    // calls. See the `ensuredCollections` field comment for invalidation.
    if (this.ensuredCollections.has(name)) {
      return;
    }

    let created = false;
    try {
      await this.client.getCollection(name);
    } catch {
      await this.client.createCollection(name, {
        vectors: {
          size: this.dimensions,
          distance: 'Cosine',
        },
      });
      created = true;
    }

    // Always verify every filterable field, including on collections that
    // existed before a particular index was introduced. The collection is
    // memoized only after all calls complete, so a partial failure retries on
    // the next use instead of becoming a permanent half-configured state.
    for (const index of REQUIRED_PAYLOAD_INDEXES) {
      await this.ensurePayloadIndex(name, index);
    }

    // Only memoized once the *entire* sequence above has succeeded — a
    // partial failure (e.g. an index call rejecting) must not be memoized,
    // so the next call retries the full sequence from scratch.
    this.ensuredCollections.add(name);
    if (created) {
      // A newly created collection changes what `listAllCollections` should
      // return; invalidate eagerly rather than waiting out the TTL.
      this.invalidateCollectionListCache();
    }
  }

  private invalidateCollectionListCache(): void {
    this.collectionListCache = null;
  }

  private async ensurePayloadIndex(
    name: string,
    index: { field_name: string; field_schema: 'keyword' | 'bool' | 'integer' | 'datetime' },
  ): Promise<void> {
    try {
      await this.client.createPayloadIndex(name, index);
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
      const points = [{
        id,
        vector,
        payload: { ...payload, namespace },
      }];
      try {
        await this.client.upsert(name, { wait: true, points });
      } catch (err) {
        // The memoized collection no longer exists on the server (deleted by
        // another device, or an operator) — invalidate the memo, re-ensure,
        // and retry exactly once. A second not-found propagates rather than
        // looping.
        if (!this.isNotFoundError(err)) {
          throw err;
        }
        this.ensuredCollections.delete(name);
        this.invalidateCollectionListCache();
        await this.ensureCollection(namespace, collection);
        await this.client.upsert(name, { wait: true, points });
      }
    });
  }

  /** Refreshes filter/ranking metadata without changing an embedding. */
  async updatePayload(
    namespace: string,
    collection: string,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.executeWithBreaker(async () => {
      const name = this.collectionName(namespace, collection);
      await this.ensureCollection(namespace, collection);
      await this.client.setPayload(name, {
        wait: true,
        points: [id],
        payload: { ...payload, namespace },
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
    await this.executeWithBreaker(async () => {
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
    });
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
      const prefix = `${COLLECTION_PREFIX}${encodeCollectionNameSegment(namespace)}_`;
      targets = all.filter(n => n.startsWith(prefix));
      if (targets.length === 0) return [];
    }

    // bound-qdrant-http-runtime task 1.4: a collectionless query otherwise fans
    // out to every collection in the namespace at once — unbounded in width (a
    // namespace with hundreds of collections), in-flight concurrency (one
    // `Promise.all` over the whole target list), and per-target result cost (a
    // large caller-supplied `limit` applied identically to every target).
    // Truncate the target list deterministically (first `max_collections`, in
    // the order `listAllCollections` returned them), run the fan-out in
    // fixed-size concurrency batches rather than firing every query at once —
    // the same batched-concurrency shape already used for consolidation's
    // neighbor fan-out (src/tools/index.ts) — and clamp each target's own
    // `limit` to `per_target_limit` (see below) while genuinely fanning out.
    // Width and truncation are surfaced via metrics/logs, not the return
    // value, so this stays additive to existing callers of `search`.
    const fanoutConfig = this.config.qdrant.fanout;
    const requestedWidth = targets.length;
    let truncated = false;
    if (targets.length > 1 && targets.length > fanoutConfig.max_collections) {
      targets = targets.slice(0, fanoutConfig.max_collections);
      truncated = true;
    }
    if (targets.length > 1) {
      this.metrics?.setGauge('bhgbrain_qdrant_fanout_width', targets.length);
      if (truncated) {
        this.metrics?.incCounter('bhgbrain_qdrant_fanout_truncated_total');
        this.logger?.warn({
          event: 'qdrant_fanout_truncated',
          namespace,
          requested_collections: requestedWidth,
          queried_collections: targets.length,
          max_collections: fanoutConfig.max_collections,
        });
      }
    }

    // Per-target result budget: only clamps while genuinely fanning out
    // (more than one target) — a single explicit `collection` search keeps
    // using the caller's `limit` directly, unchanged from before this task.
    const perTargetLimit = targets.length > 1 ? Math.min(limit, fanoutConfig.per_target_limit) : limit;

    const fanoutConcurrency = Math.max(1, fanoutConfig.concurrency);
    const perCollection: Array<Array<{ id: unknown; score: number; payload?: Record<string, unknown> | null; vector?: unknown }>> = [];
    for (let i = 0; i < targets.length; i += fanoutConcurrency) {
      const batch = targets.slice(i, i + fanoutConcurrency);
      const batchResults = await Promise.all(batch.map(name =>
        this.executeWithBreaker(() => this.client.query(name, {
          query: vector,
          limit: perTargetLimit,
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
      perCollection.push(...batchResults);
    }

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
        err,
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
        err,
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
    // bound-qdrant-http-runtime task 1.1/2.1: deliberately uses `healthClient`
    // (its own short `qdrant.health_timeout_ms` client-side deadline) rather
    // than `client`, and is never routed through `executeWithBreaker` — a
    // stalled dependency must fail this probe on its own short timeout, not
    // wait on (or itself trip) the longer operational breaker.
    const name = this.collectionName(this.config.defaults.namespace, this.config.defaults.collection);
    try {
      await this.healthClient.query(name, {
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
    return this.executeWithBreaker(async () => {
      try {
        const info = await this.client.getCollection(name);
        return { points_count: info.points_count ?? 0 };
      } catch (err) {
        // bound-qdrant-http-runtime task 1.3: only a confirmed missing
        // collection is a tolerated `null` — routing, auth, timeout, and other
        // service failures must propagate so callers (retention GC's
        // compaction check) can distinguish "nothing to compact" from "the
        // dependency call itself failed".
        if (this.isNotFoundError(err)) {
          return null;
        }
        throw err;
      }
    });
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
    await this.executeWithBreaker(async () => {
      try {
        await this.client.deleteCollection(name);
      } catch (err) {
        if (!this.isNotFoundError(err)) {
          throw err;
        }
        // Already gone — the ensured-memo and list cache still need clearing
        // below so a later write re-ensures instead of trusting a stale memo.
      }
    });
    this.ensuredCollections.delete(name);
    this.invalidateCollectionListCache();
  }

  async createSnapshot(namespace: string, collection: string): Promise<string | null> {
    const name = this.collectionName(namespace, collection);
    return this.executeWithBreaker(async () => {
      try {
        const snapshot = await this.client.createSnapshot(name);
        return snapshot?.name ?? null;
      } catch (err) {
        if (this.isNotFoundError(err)) {
          return null;
        }
        throw err;
      }
    });
  }

  /**
   * strengthen-operational-observability task 3.2: total point count across
   * every collection this store manages (`bhgbrain_*`, per `listAllCollections`
   * — itself already short-TTL cached), for the bidirectional "does Qdrant
   * hold more points than SQLite has authoritative rows for" health signal.
   * A single missing collection (raced a concurrent delete between the list
   * and this call) contributes 0 rather than failing the whole count — the
   * signal is meant to be a cheap, best-effort cross-check, not a strict
   * transactional read.
   */
  async getTotalManagedPointsCount(): Promise<number> {
    const names = await this.listAllCollections();
    const counts = await Promise.all(names.map(async name => this.executeWithBreaker(async () => {
      try {
        const info = await this.client.getCollection(name);
        return info.points_count ?? 0;
      } catch (err) {
        if (this.isNotFoundError(err)) {
          return 0;
        }
        throw err;
      }
    })));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  async listAllCollections(): Promise<string[]> {
    const now = Date.now();
    if (this.collectionListCache && this.collectionListCache.expiresAt > now) {
      return this.collectionListCache.names;
    }
    const response = await this.executeWithBreaker(() => this.client.getCollections());
    const names = response.collections
      .map(c => c.name)
      .filter(name => name.startsWith(COLLECTION_PREFIX));
    this.collectionListCache = { names, expiresAt: now + QdrantStore.COLLECTION_LIST_TTL_MS };
    return names;
  }

  /**
   * Pages through `collectionName` one server round trip at a time, yielding
   * each page as it arrives rather than accumulating the whole collection in
   * memory — used by callers that only need to inspect points once each (a
   * restored-ID/checksum reconciliation scan, bootstrap/repair hydration,
   * distillation clustering) instead of holding a potentially large corpus's
   * payloads live for the whole pass. See make-backup-restore-transactional
   * task 3.1 and bound-corpus-scale-workflows task 1.1.
   *
   * `options.payloadFields` lets a caller that only inspects a handful of
   * payload keys (checksum-drift detection: `checksum`/`device_id`/
   * `namespace`/`collection`) request Qdrant's server-side field-projected
   * `with_payload` (an explicit field list rather than `true`) instead of
   * the full record, trimming both the wire payload and the memory retained
   * per page — omit it (the default) for callers that reconstruct a whole
   * memory record and therefore need every field (bootstrap/repair
   * hydration).
   *
   * Each yielded page carries a stable `cursor` (Qdrant's own
   * `next_page_offset`, opaque to the caller) that can be handed back via
   * `options.cursor` to resume scanning a collection from exactly where a
   * prior pass left off — e.g. across a deadline-bounded caller's
   * invocations — and `done`, true once no further page remains.
   *
   * `options.isCancelled`, when provided, is polled before each server round
   * trip; once it reports true the generator yields one final page with
   * `cancelled: true` and an empty `points` array and returns, so a caller
   * enforcing a deadline or responding to shutdown never blocks the event
   * loop waiting on a page it no longer needs. `scrollAll` below is a thin
   * accumulator over this for callers that do need the full list at once.
   */
  async *scrollAllPages(
    collectionName: string,
    options: ScrollPageOptions = {},
  ): AsyncGenerator<ScrollPageResult> {
    const batchSize = options.batchSize ?? 100;
    const withVector = options.withVector ?? false;
    let offset: string | number | undefined = options.cursor;

    while (true) {
      if (options.isCancelled?.()) {
        yield { points: [], cursor: offset ?? null, done: false, cancelled: true };
        return;
      }

      const response = await this.executeWithBreaker(() => this.client.scroll(collectionName, {
        limit: batchSize,
        offset,
        with_payload: options.payloadFields ?? true,
        with_vector: withVector,
      }));

      const points = response.points.map(point => ({
        id: point.id as string,
        payload: (point.payload ?? {}) as Record<string, unknown>,
        vector: withVector ? extractDenseVector(point.vector) : undefined,
      }));

      const nextOffset = response.next_page_offset as string | number | undefined;
      const done = !nextOffset;
      yield { points, cursor: nextOffset ?? null, done, cancelled: false };

      if (done) break;
      offset = nextOffset;
    }
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
    for await (const page of this.scrollAllPages(collectionName, { batchSize, withVector })) {
      allPoints.push(...page.points);
    }
    return allPoints;
  }

  /**
   * `scrollAll` scoped to one namespace/collection, resolving the internal
   * prefixed collection name so callers never need to duplicate
   * `collectionName`'s prefix convention. A collection that has never been
   * written to simply yields no points, same convention as
   * `searchSimilar`/`findNeighborsById`.
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

  /**
   * Paged counterpart to `scrollCollection` — namespace/collection-scoped
   * `scrollAllPages`, for callers (distillation clustering) that need
   * incremental pages rather than a fully-buffered array. A collection that
   * has never been written to simply yields no pages, same tolerant
   * convention as `scrollCollection`.
   */
  async *scrollCollectionPages(
    namespace: string,
    collection: string,
    options: ScrollPageOptions = {},
  ): AsyncGenerator<ScrollPageResult> {
    const name = this.collectionName(namespace, collection);
    try {
      yield* this.scrollAllPages(name, options);
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return;
      }
      throw err;
    }
  }

  /**
   * bound-qdrant-http-runtime task 1.3: narrowed so only a *confirmed missing
   * managed collection or point* is treated idempotently. The real client's
   * generic HTTP error wrapper (`QdrantClientUnexpectedResponseError`) never
   * sets `.status`/`.response.status` and its message is just
   * `"Unexpected Response: 404 (Not Found)\n..."` for ANY non-2xx response —
   * including a routing failure, an ingress/reverse-proxy's own 404 page, or
   * every endpoint on the route going 404 (e.g. a misconfigured URL). Such a
   * bare 404 must surface as a real failure (unhealthy/thrown), not silently
   * collapse into "the collection doesn't exist yet". Only Qdrant's own
   * not-found errors, which always name what's missing ("Collection `x`
   * doesn't exist!", "Not found: Collection `x`...", a missing point, etc.),
   * are treated as idempotent no-ops.
   */
  private isNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const maybeErr = err as { status?: number; response?: { status?: number }; message?: string };
    const status = maybeErr.status ?? maybeErr.response?.status;
    const message = maybeErr.message?.toLowerCase() ?? '';
    const is404 = status === 404 || message.includes('(not found)') || message.includes('404 ');
    if (!is404) return false;
    return message.includes('does not exist') || message.includes('doesn\'t exist') ||
      (message.includes('not found') && (message.includes('collection') || message.includes('point')));
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

    // Every managed collection is gone (or never existed) — clear the whole
    // ensured-memo and the list cache rather than pruning entry by entry.
    this.ensuredCollections.clear();
    this.invalidateCollectionListCache();

    return managedNames.length;
  }
}
