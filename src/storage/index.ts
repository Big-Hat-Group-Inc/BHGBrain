import { v4 as uuidv4 } from 'uuid';
import { SqliteStore } from './sqlite.js';
import type { LifecycleOperationToken, ActivateDatabaseImageOptions } from './sqlite.js';
import { QdrantStore } from './qdrant.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryRecord, MemoryOrigin, WriteOperation, AuditEntry, LifecycleAuditDetails } from '../domain/types.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { BrainConfig } from '../config/index.js';
import { internal, conflict, notFound } from '../errors/index.js';
import { computeChecksum } from '../domain/normalize.js';
import { summarizeContent } from '../domain/summarize.js';
import type { SummarizationProvider } from '../summarization/index.js';

type MemoryRecordWithoutEmbedding = Omit<MemoryRecord, 'embedding'>;

export interface VectorDriftReconciliationOutcome {
  // 'no-drift': every restored memory's vector already matches Qdrant; nothing
  //   was cleared or marked unsynced.
  // 'partial-drift': only the memories whose content checksum differs from (or
  //   is missing in) Qdrant were marked unsynced for re-embedding — genuine
  //   checksum drift, not a model change or a read failure.
  // 'full-rebuild': the embedding model or dimensions changed since the
  //   backup was created, so every existing vector is the wrong
  //   dimensionality regardless of content — managed collections were
  //   cleared and every memory was marked unsynced.
  // 'inspection-failed': Qdrant's existing vector state could not be read
  //   (a transient outage, not a model change), so per-memory drift can't be
  //   trusted and every memory was marked unsynced as a conservative
  //   fallback — but, unlike 'full-rebuild', nothing was cleared: the
  //   existing (still dimensionally valid) vectors are left in place and
  //   keep serving search until reconciliation individually replaces each
  //   one. Kept distinct from 'full-rebuild' (make-backup-restore-
  //   transactional task 3.3) so a transient read outage is never reported
  //   to callers/health as "the embedding model changed".
  mode: 'no-drift' | 'partial-drift' | 'full-rebuild' | 'inspection-failed';
  driftedCount: number;
  // Vector-only points (no corresponding row in the restored SQLite image)
  // that were found and deleted this pass, vs. found but left unpruned
  // because their delete batch failed (0/0 in the 'full-rebuild' and
  // 'inspection-failed' modes, where surplus is not computed — see
  // detectAndMarkVectorDrift). See make-backup-restore-transactional tasks
  // 3.1/3.2.
  surplusPruned: number;
  surplusRemaining: number;
}

export interface ReconcileVectorsResult {
  reconciled: number;
  remaining: number;
  failed: number;
  permanentFailures: number;
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
    // Optional LLM-backed summarization provider (improve-memory-summarization).
    // Undefined when `pipeline.summarization_enabled` is false — `revertMemory`
    // falls back to the extractive tier via `summarizeContent`, which handles
    // an undefined provider the same way it handles an undefined `config`.
    private readonly summarizer?: SummarizationProvider,
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
    if (!existing) throw notFound(`Memory ${id} not found for update`);

    if (newVector) {
      this.ensureEmbeddingIdentityCompatible();
    }

    // A new vector re-stamps the row with the active identity; a metadata-only
    // update (no newVector) leaves whatever stamp the row already carries.
    const effectiveFields: Partial<MemoryRecordWithoutEmbedding> = newVector
      ? { ...fields, embedding_model: this.embedding.identity }
      : fields;

    const revisedAt = new Date().toISOString();
    const history = existing.retention_tier === 'T0' && fields.content !== undefined && fields.content !== existing.content
      ? {
        priorContent: existing.content,
        revisedAt,
        audit: {
          id: uuidv4(),
          timestamp: revisedAt,
          namespace: existing.namespace,
          operation: 'REVISE' as const,
          memory_id: id,
          client_id: 'system',
          details: JSON.stringify({
            memory_id: id,
            prior_tier: existing.retention_tier,
            new_tier: fields.retention_tier ?? existing.retention_tier,
            actor: 'system',
            timestamp: revisedAt,
            action: 'revise',
          }),
        },
      }
      : undefined;

    if (newVector) {
      try {
        // Qdrant is a rebuildable projection. Writing it first means a failed
        // vector request cannot create a durable T0 revision/audit record for
        // a content change that never became visible to retrieval.
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
        this.commitUpdateWithHistory(id, effectiveFields, history);
        this.sqlite.markVectorSync(id, true);
      } catch (err) {
        // If Qdrant succeeded but local commit failed, leave the authoritative
        // row untouched and mark it for a repair pass. No rollback revision is
        // written, so history cannot claim a change that never committed.
        try {
          this.sqlite.markVectorSync(id, false);
        } catch {
          // The primary vector/local failure remains the caller-visible error.
        }
        this.sqlite.flushIfDirty();
        throw internal(`Qdrant or local update failed; SQLite remains authoritative and requires reconciliation: ${(err as Error).message}`);
      }
    } else {
      this.commitUpdateWithHistory(id, effectiveFields, history);
      try {
        await this.refreshVectorPayload({ ...existing, ...effectiveFields, collection: existing.collection });
      } catch (err) {
        this.sqlite.markVectorSync(id, false);
        this.sqlite.flushIfDirty();
        throw internal(`Metadata update persisted locally but vector payload refresh requires reconciliation: ${(err as Error).message}`);
      }
    }

    this.sqlite.flushIfDirty();
  }

  /**
   * Reverts a memory's content to a prior revision: re-embeds the target
   * revision's content and applies it through `updateMemory` (new checksum,
   * re-upserted vector, append-only history), then records a distinct
   * REVISE audit entry carrying the source revision number so it is
   * distinguishable from `updateMemory`'s own generic T0-snapshot REVISE.
   *
   * The re-embed happens before any write so an embedding-provider outage
   * (`EMBEDDING_UNAVAILABLE`) leaves the memory completely unchanged rather
   * than landing a partial write or desyncing the vector store.
   */
  async revertMemory(
    id: string,
    revision: number,
    clientId = 'unknown',
  ): Promise<MemoryRecordWithoutEmbedding> {
    const existing = this.sqlite.getMemoryById(id);
    if (!existing) throw notFound(`Memory ${id} not found`);

    const target = this.sqlite.listRevisions(id).find(r => r.revision === revision);
    if (!target) throw notFound(`Revision ${revision} not found for memory ${id}`);

    const vector = await this.embedding.embed(target.content);
    const summary = await summarizeContent(target.content, this.config, this.summarizer);

    await this.updateMemory(id, {
      content: target.content,
      summary,
      checksum: computeChecksum(target.content),
      last_operation: 'UPDATE',
      updated_at: new Date().toISOString(),
    }, vector);

    this.logAudit('REVISE', id, existing.namespace, clientId, {
      details: {
        memory_id: id,
        prior_tier: existing.retention_tier,
        new_tier: existing.retention_tier,
        actor: clientId,
        timestamp: new Date().toISOString(),
        action: 'revise',
        source_revision: revision,
      },
    });

    const updated = this.sqlite.getMemoryById(id);
    if (!updated) throw internal(`Memory ${id} disappeared during revert`);
    return updated;
  }

  async deleteMemory(id: string, options?: { flush?: boolean; lifecycleToken?: LifecycleOperationToken }): Promise<boolean> {
    const mem = this.sqlite.getMemoryById(id);
    if (!mem) return false;
    this.stageDeletionIntent([id], options?.lifecycleToken);
    try {
      await this.qdrant.delete(mem.namespace, mem.collection, id);
    } catch (err) {
      this.clearFailedDeletionIntent([id], options?.lifecycleToken, mem, err);
      throw internal(`Qdrant delete failed: ${(err as Error).message}`);
    }
    let deleted: number;
    try {
      deleted = this.deleteStagedMemories([id], options?.lifecycleToken);
    } catch (err) {
      // Vector cleanup was confirmed, so keep the local tombstone pending
      // rather than reviving a row that now has no vector.
      this.recordConsistencyEvent(mem, err, undefined, options?.lifecycleToken);
      throw internal(`SQLite delete failed after Qdrant cleanup; deletion remains pending: ${(err as Error).message}`);
    }
    if (options?.flush !== false) {
      this.sqlite.flushIfDirty();
    }
    return deleted > 0;
  }

  async deleteMemories(
    memories: Array<Pick<MemoryRecord, 'id' | 'namespace' | 'collection'>>,
    options?: { flush?: boolean; lifecycleToken?: LifecycleOperationToken },
  ): Promise<DeleteMemoriesResult> {
    if (memories.length === 0) return { deleted: 0, unreconciled: [], degraded: false };

    const allIds = memories.map(memory => memory.id);
    this.stageDeletionIntent(allIds, options?.lifecycleToken);

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
      } catch (primary) {
        unreconciled.push(...ids);
        const sample = memories.find(memory => memory.id === ids[0]);
        this.clearFailedDeletionIntent(ids, options?.lifecycleToken, sample, primary);
      }
    }

    // Chunked, single-transaction batch delete (trim-sqlite-query-and-health-overhead
    // task 2.2) instead of a per-row `deleteMemory` loop — no per-row existence
    // probe, and `deleteMemoriesByIds` already scopes cleanly to the confirmed set.
    const confirmedIds = memories.map(m => m.id).filter(id => confirmed.has(id));
    let deleted = 0;
    if (confirmedIds.length > 0) {
      try {
        deleted = this.deleteStagedMemories(confirmedIds, options?.lifecycleToken);
      } catch (err) {
        const sample = memories.find(memory => memory.id === confirmedIds[0]);
        this.recordConsistencyEvent(sample, err, undefined, options?.lifecycleToken);
        throw internal(`SQLite delete failed after Qdrant cleanup; confirmed deletions remain pending: ${(err as Error).message}`);
      }
    }

    if (options?.flush !== false) {
      this.sqlite.flushIfDirty();
    }
    return { deleted, unreconciled, degraded: unreconciled.length > 0 };
  }

  private stageDeletionIntent(ids: string[], lifecycleToken?: LifecycleOperationToken): void {
    const sqlite = this.sqlite as SqliteStore & {
      stageDeletionIntent?: (ids: string[], options?: { lifecycleToken?: LifecycleOperationToken }) => void;
    };
    if (sqlite.stageDeletionIntent) {
      if (lifecycleToken) sqlite.stageDeletionIntent(ids, { lifecycleToken });
      else sqlite.stageDeletionIntent(ids);
      return;
    }
    // Lightweight test/legacy doubles lack the new intent API. Preserve the
    // pre-existing visible degraded marker while production stores always use
    // the durable pending state above.
    if (lifecycleToken) this.sqlite.markVectorsSyncBatch(ids, false, { lifecycleToken });
    else this.sqlite.markVectorsSyncBatch(ids, false);
  }

  private deleteStagedMemories(ids: string[], lifecycleToken?: LifecycleOperationToken): number {
    return lifecycleToken
      ? this.sqlite.deleteMemoriesByIds(ids, lifecycleToken)
      : this.sqlite.deleteMemoriesByIds(ids);
  }

  private clearFailedDeletionIntent(
    ids: string[], lifecycleToken: LifecycleOperationToken | undefined,
    memory: Pick<MemoryRecord, 'id' | 'namespace'> | undefined,
    primary: unknown,
  ): void {
    try {
      const sqlite = this.sqlite as SqliteStore & {
        clearDeletionIntent?: (ids: string[], options?: { lifecycleToken?: LifecycleOperationToken; vectorSynced?: boolean }) => void;
      };
      if (sqlite.clearDeletionIntent) {
        if (lifecycleToken) sqlite.clearDeletionIntent(ids, { lifecycleToken, vectorSynced: false });
        else sqlite.clearDeletionIntent(ids, { vectorSynced: false });
      } else if (lifecycleToken) {
        this.sqlite.markVectorsSyncBatch(ids, false, { lifecycleToken });
      } else {
        this.sqlite.markVectorsSyncBatch(ids, false);
      }
    } catch (compensation) {
      this.recordConsistencyEvent(memory, primary, compensation, lifecycleToken);
    }
  }

  private recordConsistencyEvent(
    memory: Pick<MemoryRecord, 'id' | 'namespace'> | undefined,
    primary: unknown,
    compensation: unknown,
    lifecycleToken?: LifecycleOperationToken,
  ): void {
    if (!memory) return;
    try {
      this.logAudit('DELETE', memory.id, memory.namespace, 'system', {
        flush: false,
        lifecycleToken,
        details: {
          memory_id: memory.id,
          prior_tier: null,
          new_tier: null,
          actor: 'system',
          timestamp: new Date().toISOString(),
          action: 'delete',
          consistency_error: primary instanceof Error ? primary.message : String(primary),
          compensation_error: compensation instanceof Error ? compensation.message : compensation === undefined ? undefined : String(compensation),
        },
      });
    } catch {
      // An audit failure is itself best-effort and must never mask the primary
      // deletion or compensation failure.
    }
  }

  private commitUpdateWithHistory(
    id: string,
    fields: Partial<MemoryRecordWithoutEmbedding>,
    history: Parameters<SqliteStore['updateMemoryWithHistory']>[2],
  ): void {
    const sqlite = this.sqlite as SqliteStore & {
      updateMemoryWithHistory?: SqliteStore['updateMemoryWithHistory'];
    };
    if (sqlite.updateMemoryWithHistory) {
      sqlite.updateMemoryWithHistory(id, fields, history);
      return;
    }
    // Test/legacy-double compatibility only. Real stores use the atomic
    // method above; retaining this fallback keeps external mock consumers from
    // breaking while they migrate their SQLite adapter.
    if (history) {
      this.sqlite.insertNextRevision(id, history.priorContent, history.revisedAt);
      this.sqlite.insertAudit(history.audit);
    }
    this.sqlite.updateMemory(id, fields);
  }

  private async refreshVectorPayload(memory: MemoryRecordWithoutEmbedding): Promise<void> {
    const qdrant = this.qdrant as QdrantStore & {
      updatePayload?: (
        namespace: string, collection: string, id: string, payload: Record<string, unknown>,
      ) => Promise<void>;
    };
    if (!qdrant.updatePayload) {
      // External adapters compiled against the former QdrantStore surface
      // cannot refresh in-place. Marking drift gives the existing bounded
      // reconciler a safe recovery route until they implement updatePayload.
      this.sqlite.markVectorSync(memory.id, false);
      return;
    }
    await qdrant.updatePayload(
      memory.namespace,
      memory.collection,
      memory.id,
      toQdrantPayload(memory),
    );
  }

  private markVectorFailure(
    id: string,
    message: string,
    permanent: boolean,
    lifecycleToken?: LifecycleOperationToken,
  ): void {
    const sqlite = this.sqlite as SqliteStore & {
      markVectorSyncFailure?: (
        id: string, error: string, permanent: boolean,
        options?: { lifecycleToken?: LifecycleOperationToken },
      ) => void;
    };
    if (sqlite.markVectorSyncFailure) {
      if (lifecycleToken) sqlite.markVectorSyncFailure(id, message, permanent, { lifecycleToken });
      else sqlite.markVectorSyncFailure(id, message, permanent);
      return;
    }
    if (lifecycleToken) this.sqlite.markVectorSync(id, false, { lifecycleToken });
    else this.sqlite.markVectorSync(id, false);
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

  /**
   * Activates a full replacement SQLite image (a restored backup) through
   * `SqliteStore.activateDatabaseImage`, which closes the live connection
   * before writing over `brain.db` — required on Windows, where a native
   * engine's open file handle blocks a rename onto the same path. See
   * migrate-sqlite-to-native-engine design.md "Restore must
   * close-before-overwrite".
   */
  async activateSqliteImage(image: Buffer, options?: ActivateDatabaseImageOptions): Promise<void> {
    await this.sqlite.activateDatabaseImage(image, options);
  }

  markAllMemoriesVectorSync(synced: boolean, options?: { lifecycleToken?: LifecycleOperationToken }): number {
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

    // Preloaded once for the whole bootstrap run (trim-sqlite-query-and-health-overhead
    // task 2.3) so per-point existence checks become a Set lookup instead of a
    // `getMemoryById` query; `hydrateBatch` mutates this in place as it inserts.
    const existingIds = this.sqlite.listMemoryIds();

    let total = 0;
    for (const collectionName of collections) {
      const points = await this.qdrant.scrollAll(collectionName);
      const filteredPoints = deviceFilter
        ? points.filter(point => {
            const pointDeviceId = typeof point.payload.device_id === 'string' ? point.payload.device_id : null;
            return pointDeviceId === deviceFilter;
          })
        : points;

      // Hydration is best-effort across the whole scan: one point that fails a
      // SQLite constraint (fails loudly, atomically — see hydrateBatch) must not
      // silently succeed, but it also must not abort the remaining points in this
      // collection or in later collections. One BEGIN/COMMIT per collection (task
      // 2.4) instead of one per point, with a SAVEPOINT per point preserving that
      // same per-point atomicity/isolation.
      const { hydrated, failures } = this.sqlite.hydrateBatch(filteredPoints, existingIds);
      for (const failure of failures) {
        logFailure(`[bootstrap] failed to hydrate point ${failure.id} in ${collectionName}: ${failure.error}`, {
          collection: collectionName,
          point_id: failure.id,
        });
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
   * Streams every point in every managed Qdrant collection exactly once
   * (page by page via `scrollAllPages`, never buffering a whole collection)
   * and, against `sqliteChecksums` (the restored SQLite image — the source
   * of truth), computes:
   *  - `driftedIds`: SQLite memory ids whose Qdrant checksum differs from
   *    (or is entirely missing from) the restored row's checksum — these
   *    need re-embedding.
   *  - `surplus`: Qdrant points that exist but have NO corresponding row in
   *    the restored SQLite image at all — vector-only orphans a restore to
   *    an older backup can leave behind. A point is only a surplus
   *    *candidate* when its payload's `device_id` is absent (legacy, predates
   *    device stamping) or matches `deviceId` (this device's own data);
   *    a point stamped with a *different* device's id is the intended
   *    cross-device search fallback (device-namespace-partitioning) and is
   *    never touched here, restore or not.
   *
   * See make-backup-restore-transactional task 3.1.
   */
  private async computeVectorReconciliationDiff(
    sqliteChecksums: Map<string, string>,
    deviceId: string | null,
  ): Promise<{ driftedIds: string[]; surplus: Array<{ namespace: string; collection: string; id: string }> }> {
    const collections = await this.qdrant.listAllCollections();
    const seenWithMatchingChecksum = new Set<string>();
    const drifted = new Set<string>();
    const surplus: Array<{ namespace: string; collection: string; id: string }> = [];

    for (const name of collections) {
      for await (const page of this.qdrant.scrollAllPages(name)) {
        for (const point of page) {
          const expectedChecksum = sqliteChecksums.get(point.id);
          if (expectedChecksum !== undefined) {
            const actualChecksum = point.payload.checksum;
            if (actualChecksum === expectedChecksum) {
              seenWithMatchingChecksum.add(point.id);
            } else {
              drifted.add(point.id);
            }
            continue;
          }

          const pointDeviceId = typeof point.payload.device_id === 'string' ? point.payload.device_id : null;
          if (pointDeviceId !== null && pointDeviceId !== deviceId) continue;

          const namespace = typeof point.payload.namespace === 'string' ? point.payload.namespace : null;
          const collection = typeof point.payload.collection === 'string' ? point.payload.collection : null;
          // Can't target a delete without knowing where it lives; leave it
          // for a future pass rather than guessing.
          if (namespace === null || collection === null) continue;
          surplus.push({ namespace, collection, id: point.id });
        }
      }
    }

    // A restored row whose id was never seen in Qdrant with a matching
    // checksum (missing outright, or seen but drifted) needs re-embedding.
    for (const id of sqliteChecksums.keys()) {
      if (!seenWithMatchingChecksum.has(id)) drifted.add(id);
    }

    return { driftedIds: [...drifted], surplus };
  }

  /**
   * Deletes surplus (vector-only orphan) points in bounded batches, grouped
   * by their owning namespace/collection. A batch failure is recorded and
   * skipped rather than aborting the whole pass, so one unreachable
   * collection cannot block pruning the rest. See make-backup-restore-
   * transactional task 3.2.
   */
  private async pruneVectorSurplus(
    surplus: Array<{ namespace: string; collection: string; id: string }>,
    batchSize = 100,
  ): Promise<{ deleted: number; remaining: number }> {
    const groups = new Map<string, { namespace: string; collection: string; ids: string[] }>();
    for (const point of surplus) {
      const key = `${point.namespace} ${point.collection}`;
      const group = groups.get(key);
      if (group) {
        group.ids.push(point.id);
      } else {
        groups.set(key, { namespace: point.namespace, collection: point.collection, ids: [point.id] });
      }
    }

    let deleted = 0;
    for (const { namespace, collection, ids } of groups.values()) {
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        try {
          await this.qdrant.deleteMany(namespace, collection, batch);
          deleted += batch.length;
        } catch {
          this.metrics?.incCounter('bhgbrain_restore_orphan_prune_failed_total', batch.length);
          // Left unpruned; retried on the next reconciliation pass (another
          // restore, or a future explicit orphan-sweep) rather than losing
          // track of it. The caller (BackupService) logs the aggregate
          // remaining count and keeps restore results/health degraded.
        }
      }
    }

    return { deleted, remaining: surplus.length - deleted };
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
   *
   * When drift *can* be determined, this also prunes vector-only surplus
   * (points with no corresponding restored SQLite row) in bounded batches —
   * see `computeVectorReconciliationDiff`/`pruneVectorSurplus` and
   * make-backup-restore-transactional tasks 3.1-3.3. Surplus pruning is
   * skipped in the model-change/inspection-failed branches: the former
   * already clears every managed vector, and the latter couldn't read
   * Qdrant's state reliably enough to tell surplus from valid data.
   */
  async detectAndMarkVectorDrift(options: {
    expectedEmbeddingModel: string;
    expectedEmbeddingDimensions: number;
    lifecycleToken?: LifecycleOperationToken;
    deviceId?: string | null;
  }): Promise<VectorDriftReconciliationOutcome> {
    const modelChanged = options.expectedEmbeddingModel !== this.embedding.model
      || options.expectedEmbeddingDimensions !== this.embedding.dimensions;

    if (modelChanged) {
      await this.clearManagedVectors();
      const driftedCount = this.markAllMemoriesVectorSync(false, {
        lifecycleToken: options.lifecycleToken,
      });
      return { mode: 'full-rebuild', driftedCount, surplusPruned: 0, surplusRemaining: 0 };
    }

    const sqliteChecksums = new Map(this.sqlite.listMemoryChecksums().map(row => [row.id, row.checksum]));
    let diff: { driftedIds: string[]; surplus: Array<{ namespace: string; collection: string; id: string }> };
    try {
      diff = await this.computeVectorReconciliationDiff(sqliteChecksums, options.deviceId ?? null);
    } catch {
      // Qdrant state could not be read reliably, so per-memory drift can't be
      // trusted; every memory is marked unsynced so reconciliation re-embeds
      // and upserts (idempotently overwriting) the whole corpus. Unlike the
      // model-change branch above, the embedding space itself hasn't
      // changed, so the existing vectors are still dimensionally valid and
      // are deliberately left in place — search keeps using them until each
      // is individually replaced by the (bounded, resumable) reconciliation
      // pass, instead of being destroyed up front on what may be a
      // transient read failure. Surplus can't be determined either without
      // a reliable read, so none is pruned this pass.
      const driftedCount = this.markAllMemoriesVectorSync(false, {
        lifecycleToken: options.lifecycleToken,
      });
      return { mode: 'inspection-failed', driftedCount, surplusPruned: 0, surplusRemaining: 0 };
    }

    if (diff.driftedIds.length > 0) {
      this.sqlite.markVectorsSyncBatch(diff.driftedIds, false, {
        lifecycleToken: options.lifecycleToken,
      });
      this.sqlite.flushIfDirty();
    }

    const { deleted: surplusPruned, remaining: surplusRemaining } = diff.surplus.length > 0
      ? await this.pruneVectorSurplus(diff.surplus)
      : { deleted: 0, remaining: 0 };

    return {
      mode: diff.driftedIds.length === 0 ? 'no-drift' : 'partial-drift',
      driftedCount: diff.driftedIds.length,
      surplusPruned,
      surplusRemaining,
    };
  }

  async reconcileVectorsFromSqlite(
    options?: {
      batchSize?: number;
      lifecycleToken?: LifecycleOperationToken;
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
    let failed = 0;
    let permanentFailures = 0;
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

      this.ensureEmbeddingIdentityCompatible();

      let vectors: Array<number[] | undefined>;
      try {
        vectors = await this.embedding.embedBatch(memories.map(memory => memory.content));
      } catch {
        // A batch-level provider rejection can hide which item is poisonous.
        // Retry each item below so one malformed/too-large record cannot keep
        // later IDs in this page from reconciling.
        vectors = new Array(memories.length).fill(undefined);
      }

      for (const [index, memory] of memories.entries()) {
        try {
          this.ensureCollectionCompatible(memory.namespace, memory.collection);
          const vector = vectors[index] ?? await this.embedding.embed(memory.content);
          if (!vector) throw new Error('Embedding provider returned no vector');
          const stamped = { ...memory, embedding_model: this.embedding.identity };
          await this.qdrant.upsert(
            stamped.namespace,
            stamped.collection,
            stamped.id,
            vector,
            toQdrantPayload(stamped),
          );
          this.sqlite.markVectorSync(memory.id, true, {
            lifecycleToken: options?.lifecycleToken,
            embeddingModel: stamped.embedding_model,
          });
          reconciled++;
        } catch (err) {
          failed++;
          const permanent = isPermanentVectorFailure(err);
          if (permanent) permanentFailures++;
          this.markVectorFailure(memory.id, (err as Error).message, permanent, options?.lifecycleToken);
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

    return {
      reconciled,
      remaining: this.sqlite.countUnsyncedVectors(),
      failed,
      permanentFailures,
      boundReached,
    };
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
    const totalRemaining = this.sqlite.countMemoriesWithStaleEmbeddingStamp(activeIdentity, true);
    let converged = false;
    if (remaining === 0 && totalRemaining === 0) {
      // Completed convergence (within the requested scope) clears the
      // mismatch condition immediately, without requiring a restart. Update
      // collection metadata in the same local mutation only after every
      // vector, including legacy unstamped rows, has reached the active
      // identity so it never authorizes a mixed-model collection.
      const sqlite = this.sqlite as SqliteStore & {
        updateAllCollectionEmbeddingIdentity?: (embeddingModel: string, embeddingDimensions: number) => void;
      };
      sqlite.updateAllCollectionEmbeddingIdentity?.(this.embedding.model, this.embedding.dimensions);
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
    options?: { flush?: boolean; details?: LifecycleAuditDetails; lifecycleToken?: LifecycleOperationToken },
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
    if (options?.lifecycleToken) {
      this.sqlite.insertAudit(entry, options.lifecycleToken);
    } else {
      this.sqlite.insertAudit(entry);
    }
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

function isPermanentVectorFailure(error: unknown): boolean {
  const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : typeof candidate.statusCode === 'number'
      ? candidate.statusCode
      : undefined;
  if (status !== undefined) return status >= 400 && status < 500 && status !== 408 && status !== 429;
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : String(error).toLowerCase();
  return /invalid|malformed|too (long|large)|content policy|unsupported input/.test(message);
}

function toQdrantPayload(
  mem: Pick<
    MemoryRecordWithoutEmbedding,
    'type' | 'tags' | 'collection' | 'content' | 'summary' | 'category' | 'source' |
    'importance' | 'retention_tier' | 'decay_eligible' | 'expires_at' | 'created_at' | 'checksum' | 'pinned' |
    'confidence' | 'review_due' | 'access_count' | 'last_accessed' | 'last_operation' | 'derived_from'
  > & { device_id?: string | null; embedding_model?: string | null; origin?: MemoryOrigin | null },
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
    // Whether this memory is pinned for guaranteed inject inclusion (see
    // add-inject-pinning). Persisted so `repair --mode from-qdrant` and the
    // cross-device fallback path restore pin state instead of resetting it.
    pinned: mem.pinned,
    // Content provenance/trust (distinct from `embedding_model` above — see
    // add-memory-provenance-metadata). Stored natively (no stringification),
    // same as `tags`, since Qdrant payloads are JSON-native.
    origin: mem.origin ?? null,
    confidence: mem.confidence,
    review_due: mem.review_due ?? null,
    access_count: mem.access_count,
    last_accessed: mem.last_accessed,
    last_operation: mem.last_operation,
    derived_from: mem.derived_from ?? null,
  };
}
