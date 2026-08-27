import { v4 as uuidv4 } from 'uuid';
import { SqliteStore } from './sqlite.js';
import { QdrantStore } from './qdrant.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryRecord, WriteOperation, AuditEntry, LifecycleAuditDetails } from '../domain/types.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { BrainConfig } from '../config/index.js';
import { internal, conflict } from '../errors/index.js';

type MemoryRecordWithoutEmbedding = Omit<MemoryRecord, 'embedding'>;

export interface VectorDriftReconciliationOutcome {
  // 'no-drift': every restored memory's vector already matches Qdrant; nothing
  //   was cleared or marked unsynced.
  // 'partial-drift': only the memories whose content checksum differs from (or
  //   is missing in) Qdrant were marked unsynced for re-embedding.
  // 'full-rebuild': drift could not be reliably determined (embedding model or
  //   dimensions changed, or Qdrant state was unreadable), so every memory was
  //   marked unsynced and managed collections were cleared.
  mode: 'no-drift' | 'partial-drift' | 'full-rebuild';
  driftedCount: number;
}

export interface ReconcileVectorsResult {
  reconciled: number;
  remaining: number;
  // true when the timeout or batch cap stopped the run before every unsynced
  // memory was processed; callers should treat `remaining > 0` as "resume me".
  boundReached: boolean;
}

export interface DeleteMemoriesResult {
  // Count of memories whose SQLite row was actually removed (vector delete
  // confirmed).
  deleted: number;
  // Ids whose vector delete failed mid-batch; their SQLite rows were
  // preserved (not deleted) and their `vector_synced` flag was cleared so
  // they remain detectable as cross-store drift.
  unreconciled: string[];
  // true when `unreconciled` is non-empty, i.e. this was not a fully clean
  // pass even though it did not throw.
  degraded: boolean;
}

export interface ReembedResult {
  updated: number;
  failed: number;
  remaining: number;
  boundReached: boolean;
  // true when this run converged the store (no stale-stamped rows left under
  // the same includeLegacy scope it ran with) and the store's expected
  // identity was updated to clear the mismatch condition.
  converged: boolean;
}

export class StorageManager {
  private backgroundReconciliationActive = false;

  constructor(
    public readonly sqlite: SqliteStore,
    public readonly qdrant: QdrantStore,
    public readonly embedding: EmbeddingProvider,
    private readonly metrics?: MetricsCollector,
    // Optional so every pre-existing test-double construction site keeps
    // compiling; a missing config falls back to the schema default
    // (refuse_writes_on_model_mismatch: true) wherever it's consulted.
    private readonly config?: BrainConfig,
  ) {}

  /**
   * Provider-qualified identity the store expects new vectors to carry (see
   * embedding-provenance). Null until the first vector-producing write
   * adopts one.
   */
  getExpectedEmbeddingIdentity(): string | null {
    return this.sqlite.getExpectedEmbeddingIdentity();
  }

  /**
   * True when the store has an adopted expected identity that differs from
   * the active embedding provider's identity — the condition that degrades
   * `embedding` health and (by default) refuses vector-producing writes.
   */
  hasEmbeddingIdentityMismatch(): boolean {
    const expected = this.sqlite.getExpectedEmbeddingIdentity();
    return expected !== null && expected !== this.embedding.identity;
  }

  /**
   * Refuses vector-producing writes while the store's expected embedding
   * identity is adopted and differs from the active configuration, unless
   * the operator has explicitly opted into mixing spaces via
   * `embedding.refuse_writes_on_model_mismatch: false`. On success (no
   * mismatch, or mismatch tolerated), adopts the active identity as the
   * store's expectation if none has been recorded yet.
   */
  private ensureEmbeddingIdentityCompatible(): void {
    const expected = this.sqlite.getExpectedEmbeddingIdentity();
    const refuseOnMismatch = this.config?.embedding.refuse_writes_on_model_mismatch ?? true;
    if (expected !== null && expected !== this.embedding.identity && refuseOnMismatch) {
      throw conflict(
        `Embedding identity mismatch: this store expects "${expected}" but the active ` +
        `configuration is "${this.embedding.identity}". Vector-producing writes are refused ` +
        `to avoid mixing embedding spaces. Run the repair tool with mode: "re-embed" ` +
        `(or "bhgbrain repair --re-embed" from the CLI) to migrate existing vectors to the ` +
        `active model, or set embedding.refuse_writes_on_model_mismatch to false to allow ` +
        `writes to mix spaces.`,
      );
    }
    this.sqlite.adoptEmbeddingIdentityIfAbsent(this.embedding.identity);
  }

  isBackgroundReconciliationActive(): boolean {
    return this.backgroundReconciliationActive;
  }

  setBackgroundReconciliationActive(active: boolean): void {
    this.backgroundReconciliationActive = active;
  }

  async init(): Promise<void> {
    await this.sqlite.init();
  }

  async writeMemory(
    mem: MemoryRecordWithoutEmbedding,
    vector: number[],
  ): Promise<void> {
    this.ensureCollectionCompatible(mem.namespace, mem.collection);
    this.ensureEmbeddingIdentityCompatible();

    // Stamp the active provider-qualified identity on the row regardless of
    // what the caller passed in — this is the single point of truth for
    // "which model produced this vector" (see embedding-provenance).
    const stamped: MemoryRecordWithoutEmbedding = { ...mem, embedding_model: this.embedding.identity };

    try {
      this.sqlite.insertMemory(stamped);
    } catch (err) {
      throw internal(`SQLite write failed: ${(err as Error).message}`);
    }

    try {
      await this.qdrant.upsert(stamped.namespace, stamped.collection, stamped.id, vector, toQdrantPayload(stamped));
      this.sqlite.markVectorSync(stamped.id, true);
    } catch (err) {
      this.sqlite.markVectorSync(stamped.id, false);
      this.sqlite.flushIfDirty();
      throw internal(`Qdrant write failed after SQLite persistence: ${(err as Error).message}`);
    }

    this.sqlite.flushIfDirty();
  }

  writeMemoryWithoutVector(mem: MemoryRecordWithoutEmbedding): void {
    this.ensureCollectionCompatible(mem.namespace, mem.collection);
    try {
      this.sqlite.insertMemory({
        ...mem,
        vector_synced: false,
      });
      this.sqlite.flushIfDirty();
      this.metrics?.incCounter('degraded_writes_total');
    } catch (err) {
      throw internal(`SQLite degraded write failed: ${(err as Error).message}`);
    }
  }

  async updateMemory(
    id: string,
    fields: Partial<Omit<MemoryRecord, 'embedding'>>,
    newVector?: number[],
  ): Promise<void> {
    const existing = this.sqlite.getMemoryById(id);
    if (!existing) throw internal(`Memory ${id} not found for update`);

    if (newVector) {
      this.ensureEmbeddingIdentityCompatible();
    }

    // A new vector re-stamps the row with the active identity; a metadata-only
    // update (no newVector) leaves whatever stamp the row already carries.
    const effectiveFields: Partial<MemoryRecordWithoutEmbedding> = newVector
      ? { ...fields, embedding_model: this.embedding.identity }
      : fields;

    // Snapshot fields that will change for rollback
    const rollbackFields: Partial<MemoryRecordWithoutEmbedding> = {};
    for (const key of Object.keys(effectiveFields) as Array<keyof MemoryRecordWithoutEmbedding>) {
      const currentValue = existing[key];
      assignRollbackField(rollbackFields, key, currentValue);
    }

    if (existing.retention_tier === 'T0' && fields.content && fields.content !== existing.content) {
      const revisedAt = new Date().toISOString();
      this.sqlite.insertRevision(id, this.sqlite.listRevisions(id).length + 1, existing.content, revisedAt);
      this.logAudit('REVISE', id, existing.namespace, 'system', {
        flush: false,
        details: {
          memory_id: id,
          prior_tier: existing.retention_tier,
          new_tier: fields.retention_tier ?? existing.retention_tier,
          actor: 'system',
          timestamp: revisedAt,
          action: 'revise',
        },
      });
    }

    this.sqlite.updateMemory(id, effectiveFields);

    if (newVector) {
      try {
        await this.qdrant.upsert(
          existing.namespace,
          existing.collection,
          id,
          newVector,
          toQdrantPayload({
            ...existing,
            ...effectiveFields,
            collection: existing.collection,
          }),
        );
        this.sqlite.markVectorSync(id, true);
      } catch (err) {
        this.sqlite.updateMemory(id, rollbackFields);
        this.sqlite.markVectorSync(id, false);
        this.sqlite.flushIfDirty();
        throw internal(`Qdrant update failed, rolled back SQLite: ${(err as Error).message}`);
      }
    }

    this.sqlite.flushIfDirty();
  }

  async deleteMemory(id: string, options?: { flush?: boolean }): Promise<boolean> {
    const mem = this.sqlite.getMemoryById(id);
    if (!mem) return false;
    try {
      await this.qdrant.delete(mem.namespace, mem.collection, id);
    } catch (err) {
      throw internal(`Qdrant delete failed: ${(err as Error).message}`);
    }
    const deleted = this.sqlite.deleteMemory(id);
    if (options?.flush !== false) {
      this.sqlite.flushIfDirty();
    }
    return deleted;
  }

  async deleteMemories(
    memories: Array<Pick<MemoryRecord, 'id' | 'namespace' | 'collection'>>,
    options?: { flush?: boolean },
  ): Promise<DeleteMemoriesResult> {
    if (memories.length === 0) return { deleted: 0, unreconciled: [], degraded: false };

    const grouped = new Map<string, string[]>();
    for (const memory of memories) {
      const key = `${memory.namespace}|${memory.collection}`;
      const ids = grouped.get(key) ?? [];
      ids.push(memory.id);
      grouped.set(key, ids);
    }

    // Confirmed groups have their vectors removed and are eligible for SQLite
    // deletion below. A transient Qdrant error on any one group must not
    // throw a generic internal error after archive rows were already written
    // by the caller (the exact silent-divergence mode this batching replaced)
    // — instead the group's ids are marked unreconciled: their vectors were
    // never confirmed removed, so their SQLite rows are preserved and their
    // `vector_synced` flag is explicitly cleared so they remain visible as
    // cross-store drift rather than silently reporting a clean pass.
    const confirmed = new Set<string>();
    const unreconciled: string[] = [];
    for (const [key, ids] of grouped.entries()) {
      const [namespace, collection] = key.split('|');
      try {
        await this.qdrant.deleteMany(namespace!, collection!, ids);
        for (const id of ids) confirmed.add(id);
      } catch {
        unreconciled.push(...ids);
        this.sqlite.markVectorsSyncBatch(ids, false);
      }
    }

    let deleted = 0;
    for (const memory of memories) {
      if (!confirmed.has(memory.id)) continue;
      if (this.sqlite.deleteMemory(memory.id)) {
        deleted++;
      }
    }

    if (options?.flush !== false) {
      this.sqlite.flushIfDirty();
    }
    return { deleted, unreconciled, degraded: unreconciled.length > 0 };
  }

  countMemoriesInCollection(namespace: string, collection: string): number {
    return this.sqlite.countMemoriesInCollection(namespace, collection);
  }

  async deleteCollectionData(
    namespace: string,
    collection: string,
    options?: { logger?: { warn: (obj: Record<string, unknown>) => void } },
  ): Promise<{ deleted: number; ids: string[] }> {
    const ids = this.sqlite.listMemoryIdsInCollection(namespace, collection);
    try {
      await this.qdrant.deleteCollection(namespace, collection);
    } catch (err) {
      // Non-not-found Qdrant failure: the collection's vectors may now be
      // partially deleted or orphaned. SQLite rows are preserved (never
      // reached the delete below), but leaving them `vector_synced=true`
      // would report zero drift even though cleanup did not complete. Mark
      // them explicitly unsynced — a narrow, retryable tombstone — and emit
      // a warn signal so `unsynced_vectors` / `checkVectorReconciliation`
      // surface the residual cleanup instead of it going silent.
      if (ids.length > 0) {
        this.sqlite.markVectorsSyncBatch(ids, false);
        this.sqlite.flushIfDirty();
      }
      options?.logger?.warn({
        event: 'collection_vector_cleanup_failed',
        namespace,
        collection,
        memory_ids: ids,
        error: (err as Error).message,
      });
      throw internal(`Qdrant collection delete failed, vector cleanup incomplete: ${(err as Error).message}`);
    }
    const removed = this.sqlite.deleteMemoriesInCollection(namespace, collection);
    if (removed.deleted > 0) {
      this.sqlite.flushIfDirty();
    }
    return ids.length > 0 ? { deleted: removed.deleted, ids } : removed;
  }

  async reloadSqliteFromDisk(): Promise<void> {
    await this.sqlite.reloadFromDisk();
  }

  markAllMemoriesVectorSync(synced: boolean, options?: { allowDuringLifecycle?: boolean }): number {
    const affected = this.sqlite.markAllVectorsSyncState(synced, options);
    this.sqlite.flushIfDirty();
    return affected;
  }

  async bootstrapFromQdrant(
    logger?: { info: (obj: Record<string, unknown>) => void; warn?: (obj: Record<string, unknown>) => void },
    options?: { deviceId?: string | null; allDevices?: boolean },
  ): Promise<number> {
    const log = (msg: string, data?: Record<string, unknown>) => {
      if (logger) logger.info({ event: 'bootstrap', message: msg, ...data });
    };
    const logFailure = (msg: string, data?: Record<string, unknown>) => {
      if (logger?.warn) {
        logger.warn({ event: 'bootstrap_hydration_failed', message: msg, ...data });
      } else if (logger) {
        logger.info({ event: 'bootstrap_hydration_failed', message: msg, ...data });
      }
    };

    // Device-scoping is opt-in via `options` so the automatic startup hook (which
    // exists precisely to recover *other* devices' memories onto an empty local
    // SQLite) keeps its unfiltered behavior, while `repair --from-qdrant` — a
    // command whose contract is single-sourced with `device-namespace-partitioning`
    // — defaults to the current device and only widens on `--all-devices`.
    const deviceFilter = options?.allDevices ? null : (options?.deviceId ?? null);

    const collections = await this.qdrant.listAllCollections();
    log(`[bootstrap] hydrating from qdrant: found ${collections.length} collections`, { collections_count: collections.length });

    let total = 0;
    for (const collectionName of collections) {
      const points = await this.qdrant.scrollAll(collectionName);
      let hydrated = 0;
      for (const point of points) {
        if (deviceFilter) {
          const pointDeviceId = typeof point.payload.device_id === 'string' ? point.payload.device_id : null;
          if (pointDeviceId !== deviceFilter) {
            continue;
          }
        }
        // Hydration is best-effort across the whole scan: one point that fails a
        // SQLite constraint (fails loudly, atomically — see upsertMemoryFromPayload)
        // must not silently succeed, but it also must not abort the remaining points
        // in this collection or in later collections.
        try {
          const inserted = this.sqlite.upsertMemoryFromPayload(point.id, point.payload);
          if (inserted) hydrated++;
        } catch (err) {
          logFailure(`[bootstrap] failed to hydrate point ${point.id} in ${collectionName}: ${(err as Error).message}`, {
            collection: collectionName,
            point_id: point.id,
          });
        }
      }
      this.sqlite.flushIfDirty();
      log(`[bootstrap] collection ${collectionName}: ${hydrated} points hydrated`, { collection: collectionName, hydrated });
      total += hydrated;
    }

    log(`[bootstrap] complete: ${total} total memories hydrated`, { total });
    return total;
  }

  async clearManagedVectors(): Promise<number> {
    return this.qdrant.clearManagedCollections();
  }

  /**
   * Reads back the checksum payload field for every point in every managed
   * Qdrant collection. Used to detect drift without paying any embedding
   * cost: a point whose stored checksum matches the restored SQLite row's
   * checksum did not change and does not need to be re-embedded. Points
   * written before this field existed simply have no entry here, which the
   * caller treats as "needs re-embedding" (self-healing on first reconcile).
   */
  async collectExistingVectorChecksums(): Promise<Map<string, string>> {
    const collections = await this.qdrant.listAllCollections();
    const checksums = new Map<string, string>();
    for (const name of collections) {
      const points = await this.qdrant.scrollAll(name);
      for (const point of points) {
        const checksum = point.payload.checksum;
        if (typeof checksum === 'string') {
          checksums.set(point.id, checksum);
        }
      }
    }
    return checksums;
  }

  /**
   * Reconciles restored vector state against actual drift instead of
   * unconditionally re-embedding the whole corpus. Falls back to marking the
   * whole corpus unsynced (a full rebuild) only when drift cannot be
   * reliably determined:
   *  - the embedding model or dimensions changed since the backup was
   *    created, in which case the existing vectors are the wrong
   *    dimensionality for the current provider regardless of content, so
   *    managed collections are also cleared (there is no usable vector to
   *    preserve — a query against them would fail dimension checks anyway);
   *  - Qdrant's existing state could not be read, in which case the
   *    embedding space is unchanged and the existing vectors are left in
   *    place (not cleared) so search keeps using them until reconciliation
   *    individually replaces each one.
   */
  async detectAndMarkVectorDrift(options: {
    expectedEmbeddingModel: string;
    expectedEmbeddingDimensions: number;
    allowDuringLifecycle?: boolean;
  }): Promise<VectorDriftReconciliationOutcome> {
    const modelChanged = options.expectedEmbeddingModel !== this.embedding.model
      || options.expectedEmbeddingDimensions !== this.embedding.dimensions;

    if (modelChanged) {
      await this.clearManagedVectors();
      const driftedCount = this.markAllMemoriesVectorSync(false, {
        allowDuringLifecycle: options.allowDuringLifecycle,
      });
      return { mode: 'full-rebuild', driftedCount };
    }

    let existingChecksums: Map<string, string>;
    try {
      existingChecksums = await this.collectExistingVectorChecksums();
    } catch {
      // Qdrant state could not be read reliably, so per-memory drift can't be
      // trusted; every memory is marked unsynced so reconciliation re-embeds
      // and upserts (idempotently overwriting) the whole corpus. Unlike the
      // model-change branch above, the embedding space itself hasn't
      // changed, so the existing vectors are still dimensionally valid and
      // are deliberately left in place — search keeps using them until each
      // is individually replaced by the (bounded, resumable) reconciliation
      // pass, instead of being destroyed up front on what may be a
      // transient read failure.
      const driftedCount = this.markAllMemoriesVectorSync(false, {
        allowDuringLifecycle: options.allowDuringLifecycle,
      });
      return { mode: 'full-rebuild', driftedCount };
    }

    const rows = this.sqlite.listMemoryChecksums();
    const driftedIds = rows
      .filter(row => existingChecksums.get(row.id) !== row.checksum)
      .map(row => row.id);

    if (driftedIds.length > 0) {
      this.sqlite.markVectorsSyncBatch(driftedIds, false, {
        allowDuringLifecycle: options.allowDuringLifecycle,
      });
      this.sqlite.flushIfDirty();
    }

    return {
      mode: driftedIds.length === 0 ? 'no-drift' : 'partial-drift',
      driftedCount: driftedIds.length,
    };
  }

  async reconcileVectorsFromSqlite(
    options?: {
      batchSize?: number;
      allowDuringLifecycle?: boolean;
      // Bounds so a slow/hanging embedding provider cannot hold this loop
      // open indefinitely. When either bound is hit, the method returns with
      // `boundReached: true` and `remaining > 0`; a later call resumes from
      // the same unsynced set (it is re-queried from scratch each call).
      timeoutMs?: number;
      maxBatches?: number;
    },
  ): Promise<ReconcileVectorsResult> {
    const batchSize = options?.batchSize ?? 100;
    const startedAt = Date.now();
    let cursor: string | undefined;
    let reconciled = 0;
    let batches = 0;
    let boundReached = false;

    while (true) {
      if (options?.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
        boundReached = true;
        break;
      }
      if (options?.maxBatches !== undefined && batches >= options.maxBatches) {
        boundReached = true;
        break;
      }

      const memories = this.sqlite.listMemoriesNeedingVectorSync(batchSize, cursor);
      if (memories.length === 0) {
        break;
      }

      for (const memory of memories) {
        this.ensureCollectionCompatible(memory.namespace, memory.collection);
      }
      this.ensureEmbeddingIdentityCompatible();

      const vectors = await this.embedding.embedBatch(memories.map(memory => memory.content));

      for (const [index, memory] of memories.entries()) {
        const vector = vectors[index];
        if (!vector) {
          this.sqlite.flushIfDirty();
          throw internal(`Missing embedding vector for memory ${memory.id}`);
        }

        const stamped = { ...memory, embedding_model: this.embedding.identity };
        try {
          await this.qdrant.upsert(
            stamped.namespace,
            stamped.collection,
            stamped.id,
            vector,
            toQdrantPayload(stamped),
          );
          this.sqlite.markVectorSync(memory.id, true, {
            allowDuringLifecycle: options?.allowDuringLifecycle,
            embeddingModel: stamped.embedding_model,
          });
          reconciled++;
        } catch (err) {
          // Durability is bounded at batch granularity, not per item: this
          // flush persists every mark completed so far in *this* batch (plus
          // any prior batches) so a hard crash right after this point loses
          // at most the remainder of the in-flight batch. Restart resumes
          // from `listMemoriesNeedingVectorSync`, and `upsert`/`markVectorSync`
          // are both idempotent, so replaying the lost slice is always safe.
          this.sqlite.flushIfDirty();
          throw err;
        }
      }

      this.sqlite.flushIfDirty();
      batches++;

      if (memories.length < batchSize) {
        break;
      }
      const last = memories[memories.length - 1]!;
      cursor = `${last.created_at}|${last.id}`;
    }

    return { reconciled, remaining: this.sqlite.countUnsyncedVectors(), boundReached };
  }

  /**
   * Operator-initiated re-embed migration (openspec/changes/
   * stamp-embedding-provenance, task 3): re-embeds memories whose stamp
   * differs from the active embedding identity, in bounded, resumable
   * batches. Deliberately bypasses `ensureEmbeddingIdentityCompatible` — this
   * *is* the sanctioned remediation for the mismatch that method guards
   * against, not a write it should refuse.
   *
   * The stamp itself is the progress marker (no separate checkpoint table):
   * a batch's rows are re-queried fresh from `listMemoriesWithStaleEmbeddingStamp`
   * each iteration, so interruption at any point is safe to resume — rows
   * already re-stamped with the active identity simply stop matching the
   * selection query.
   *
   * Failures are isolated per memory: one embed/upsert failure is counted
   * and skipped (left for a future run) rather than aborting the batch, so
   * a single bad row cannot block convergence of the rest of the store.
   */
  async reembedMismatchedVectors(
    options?: {
      includeLegacy?: boolean;
      batchSize?: number;
      timeoutMs?: number;
      maxBatches?: number;
      logger?: { info?: (obj: Record<string, unknown>) => void; warn?: (obj: Record<string, unknown>) => void };
    },
  ): Promise<ReembedResult> {
    const includeLegacy = options?.includeLegacy ?? false;
    const batchSize = options?.batchSize ?? 50;
    const activeIdentity = this.embedding.identity;
    const startedAt = Date.now();
    let cursor: string | undefined;
    let updated = 0;
    let failed = 0;
    let batches = 0;
    let boundReached = false;

    while (true) {
      if (options?.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
        boundReached = true;
        break;
      }
      if (options?.maxBatches !== undefined && batches >= options.maxBatches) {
        boundReached = true;
        break;
      }

      const memories = this.sqlite.listMemoriesWithStaleEmbeddingStamp(
        activeIdentity, includeLegacy, batchSize, cursor,
      );
      if (memories.length === 0) {
        break;
      }

      for (const memory of memories) {
        try {
          const vector = await this.embedding.embed(memory.content);
          const stamped = { ...memory, embedding_model: activeIdentity };
          await this.qdrant.upsert(stamped.namespace, stamped.collection, stamped.id, vector, toQdrantPayload(stamped));
          this.sqlite.markVectorSync(stamped.id, true, { embeddingModel: activeIdentity });
          updated++;
        } catch (err) {
          failed++;
          options?.logger?.warn?.({
            event: 're_embed_item_failed',
            memory_id: memory.id,
            error: (err as Error).message,
          });
        }
      }

      this.sqlite.flushIfDirty();
      batches++;
      options?.logger?.info?.({
        event: 're_embed_batch_progress',
        batch: batches,
        updated,
        failed,
      });

      if (memories.length < batchSize) {
        break;
      }
      const last = memories[memories.length - 1]!;
      cursor = `${last.created_at}|${last.id}`;
    }

    const remaining = this.sqlite.countMemoriesWithStaleEmbeddingStamp(activeIdentity, includeLegacy);
    let converged = false;
    if (remaining === 0) {
      // Completed convergence (within the requested scope) clears the
      // mismatch condition immediately, without requiring a restart.
      this.sqlite.setExpectedEmbeddingIdentity(activeIdentity);
      converged = true;
    }

    return { updated, failed, remaining, boundReached, converged };
  }

  logAudit(
    operation: AuditEntry['operation'],
    memoryId: string,
    namespace: string,
    clientId = 'unknown',
    options?: { flush?: boolean; details?: LifecycleAuditDetails },
  ): void {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      namespace,
      operation,
      memory_id: memoryId,
      client_id: clientId,
      details: options?.details ? JSON.stringify(options.details) : undefined,
    };
    this.sqlite.insertAudit(entry);
    if (options?.flush !== false) {
      this.sqlite.flushIfDirty();
    }
  }

  private ensureCollectionCompatible(namespace: string, collection: string): void {
    const col = this.sqlite.getCollection(namespace, collection);
    if (col) {
      if (col.embedding_model !== this.embedding.model || col.embedding_dimensions !== this.embedding.dimensions) {
        // Dimension mismatches are caught here before they ever reach Qdrant
        // (whose own error would be an opaque vector-size rejection): this
        // collection's vectors were created at `col.embedding_dimensions`,
        // so a differing active dimension count can never be written into
        // it without first migrating the existing vectors.
        throw conflict(
          `Collection "${collection}" uses ${col.embedding_model} (${col.embedding_dimensions}d), ` +
          `but current provider is ${this.embedding.model} (${this.embedding.dimensions}d). ` +
          `Cannot mix embedding spaces. Run the repair tool with mode: "re-embed" (or ` +
          `"bhgbrain repair --re-embed" from the CLI) to migrate this collection's vectors ` +
          `to the active model.`,
        );
      }
      return;
    }

    this.sqlite.createCollection(
      namespace, collection,
      this.embedding.model, this.embedding.dimensions,
    );
  }
}

export { SqliteStore } from './sqlite.js';
export { QdrantStore } from './qdrant.js';

function assignRollbackField<K extends keyof MemoryRecordWithoutEmbedding>(
  target: Partial<MemoryRecordWithoutEmbedding>,
  key: K,
  value: MemoryRecordWithoutEmbedding[K],
): void {
  target[key] = value;
}

function toQdrantPayload(
  mem: Pick<
    MemoryRecordWithoutEmbedding,
    'type' | 'tags' | 'collection' | 'content' | 'summary' | 'category' | 'source' |
    'importance' | 'retention_tier' | 'decay_eligible' | 'expires_at' | 'created_at' | 'checksum'
  > & { device_id?: string | null; embedding_model?: string | null },
): Record<string, unknown> {
  return {
    type: mem.type,
    tags: mem.tags,
    collection: mem.collection,
    content: mem.content,
    summary: mem.summary,
    category: mem.category ?? null,
    source: mem.source,
    importance: mem.importance,
    retention_tier: mem.retention_tier,
    decay_eligible: mem.decay_eligible,
    expires_at: mem.expires_at ? Math.floor(Date.parse(mem.expires_at) / 1000) : null,
    device_id: mem.device_id ?? null,
    created_at: mem.created_at,
    // Content checksum, used on restore to detect drift without re-embedding
    // (see StorageManager.detectAndMarkVectorDrift).
    checksum: mem.checksum,
    // Provider-qualified embedding identity that produced this vector (see
    // embedding-provenance). Null for legacy vectors written before
    // provenance stamping.
    embedding_model: mem.embedding_model ?? null,
  };
}
