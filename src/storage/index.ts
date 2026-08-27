import { v4 as uuidv4 } from 'uuid';
import { SqliteStore } from './sqlite.js';
import { QdrantStore } from './qdrant.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryRecord, WriteOperation, AuditEntry } from '../domain/types.js';
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

export class StorageManager {
  private backgroundReconciliationActive = false;

  constructor(
    public readonly sqlite: SqliteStore,
    public readonly qdrant: QdrantStore,
    public readonly embedding: EmbeddingProvider,
  ) {}

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

    try {
      this.sqlite.insertMemory(mem);
    } catch (err) {
      throw internal(`SQLite write failed: ${(err as Error).message}`);
    }

    try {
      await this.qdrant.upsert(mem.namespace, mem.collection, mem.id, vector, toQdrantPayload(mem));
      this.sqlite.markVectorSync(mem.id, true);
    } catch (err) {
      this.sqlite.markVectorSync(mem.id, false);
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

    // Snapshot fields that will change for rollback
    const rollbackFields: Partial<MemoryRecordWithoutEmbedding> = {};
    for (const key of Object.keys(fields) as Array<keyof MemoryRecordWithoutEmbedding>) {
      const currentValue = existing[key];
      assignRollbackField(rollbackFields, key, currentValue);
    }

    if (existing.retention_tier === 'T0' && fields.content && fields.content !== existing.content) {
      this.sqlite.insertRevision(id, this.sqlite.listRevisions(id).length + 1, existing.content, new Date().toISOString());
    }

    this.sqlite.updateMemory(id, fields);

    if (newVector) {
      try {
        await this.qdrant.upsert(
          existing.namespace,
          existing.collection,
          id,
          newVector,
          toQdrantPayload({
            ...existing,
            ...fields,
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

      const vectors = await this.embedding.embedBatch(memories.map(memory => memory.content));

      for (const [index, memory] of memories.entries()) {
        const vector = vectors[index];
        if (!vector) {
          this.sqlite.flushIfDirty();
          throw internal(`Missing embedding vector for memory ${memory.id}`);
        }

        try {
          await this.qdrant.upsert(
            memory.namespace,
            memory.collection,
            memory.id,
            vector,
            toQdrantPayload(memory),
          );
          this.sqlite.markVectorSync(memory.id, true, {
            allowDuringLifecycle: options?.allowDuringLifecycle,
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

  logAudit(
    operation: WriteOperation | 'FORGET',
    memoryId: string,
    namespace: string,
    clientId = 'unknown',
    options?: { flush?: boolean },
  ): void {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      namespace,
      operation,
      memory_id: memoryId,
      client_id: clientId,
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
        throw conflict(
          `Collection "${collection}" uses ${col.embedding_model} (${col.embedding_dimensions}d), ` +
          `but current provider is ${this.embedding.model} (${this.embedding.dimensions}d). ` +
          `Cannot mix embedding spaces.`,
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
  > & { device_id?: string | null },
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
  };
}
