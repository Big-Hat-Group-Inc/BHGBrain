import { v4 as uuidv4 } from 'uuid';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager, DeleteMemoriesResult } from '../storage/index.js';
import type { ArchiveRecord, MemoryRecord, RetentionTier } from '../domain/types.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';
import type { MetricsCollector } from '../health/metrics.js';

export interface GarbageCollectionResult {
  scanned: number;
  archived: number;
  deleted: number;
  // true when one or more expired memories' vector deletion failed mid-batch;
  // `deleted` reflects only confirmed removals and `unreconciled` names the
  // rest, which remain in SQLite with `vector_synced=false` for retry.
  degraded: boolean;
  unreconciled: string[];
  candidates: Array<{
    id: string;
    tier: RetentionTier;
    summary: string;
    expires_at: string | null;
  }>;
  // T1 (institutional) memories whose expiry or review_due has passed. These
  // are never directly archived/deleted by GC — only T2/T3 are — they are
  // surfaced here so an operator (CLI/MCP) can review and act on them.
  reviewCandidates: Array<{
    id: string;
    tier: RetentionTier;
    summary: string;
    expires_at: string | null;
    review_due: string | null;
  }>;
  // Namespace/collection pairs whose Qdrant deleted-vector ratio crossed
  // `compaction_deleted_threshold` after this run and were nudged to compact.
  compacted: string[];
}

export class RetentionService {
  private lifecycle: MemoryLifecycleService;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private logger?: { info: (obj: Record<string, unknown>) => void },
    private metrics?: MetricsCollector,
  ) {
    this.lifecycle = new MemoryLifecycleService(config);
  }

  async runGc(options?: { dryRun?: boolean; tier?: RetentionTier }): Promise<GarbageCollectionResult> {
    const nowIso = new Date().toISOString();
    const gcStart = Date.now();

    // Direct archive/delete is restricted to T2/T3: T0 is never selected by
    // retention policy, and T1 requires warning/review semantics rather than
    // TTL-only deletion, so it is excluded here and surfaced separately below.
    const expiredAll = this.storage.sqlite.listExpiredMemories(nowIso, options?.tier);
    const deletable = expiredAll.filter(
      memory => memory.retention_tier === 'T2' || memory.retention_tier === 'T3',
    );
    const reviewCandidates = (!options?.tier || options.tier === 'T1')
      ? this.storage.sqlite.listReviewCandidates(nowIso)
      : [];

    const candidates = deletable.map(memory => ({
      id: memory.id,
      tier: memory.retention_tier,
      summary: memory.summary,
      expires_at: memory.expires_at,
    }));
    const reviewCandidateSummaries = reviewCandidates.map(memory => ({
      id: memory.id,
      tier: memory.retention_tier,
      summary: memory.summary,
      expires_at: memory.expires_at,
      review_due: memory.review_due,
    }));

    if (options?.dryRun) {
      this.logger?.info({
        event: 'retention_gc',
        outcome: 'dry_run',
        scanned: deletable.length,
        archived: 0,
        deleted: 0,
        degraded: false,
        review_candidates: reviewCandidateSummaries.length,
      });
      return {
        scanned: deletable.length,
        archived: 0,
        deleted: 0,
        degraded: false,
        unreconciled: [],
        candidates,
        reviewCandidates: reviewCandidateSummaries,
        compacted: [],
      };
    }

    // Bracket the destructive phase so a crash mid-run is always visible as
    // an in-progress lifecycle operation (mirrors the restore path), and
    // guarantee the lock is released via `finally` regardless of outcome.
    this.storage.sqlite.beginLifecycleOperation('gc');
    let archived = 0;
    let archiveFailed = false;
    const archivedOk: typeof deletable = [];

    try {
      for (const memory of deletable) {
        if (!this.config.retention.archive_before_delete) {
          archivedOk.push(memory);
          continue;
        }
        try {
          this.storage.sqlite.archiveMemory(memory, nowIso);
          archived++;
          this.storage.logAudit('ARCHIVE', memory.id, memory.namespace, 'system', {
            flush: false,
            details: {
              memory_id: memory.id,
              prior_tier: memory.retention_tier,
              new_tier: null,
              actor: 'system',
              timestamp: nowIso,
              action: 'archive',
            },
          });
          archivedOk.push(memory);
        } catch (err) {
          // Archival failed for this one memory: skip it for deletion (never
          // delete without a durable archive row when archival is enabled)
          // and keep going so one bad row doesn't abort the whole run.
          archiveFailed = true;
          this.logger?.info({
            event: 'retention_gc_archive_failed',
            memory_id: memory.id,
            error: (err as Error).message,
          });
        }
      }

      let deleteResult: DeleteMemoriesResult;
      try {
        deleteResult = await this.storage.deleteMemories(archivedOk, { flush: false });
      } catch (err) {
        this.logger?.info({ event: 'retention_gc_delete_failed', error: (err as Error).message });
        deleteResult = { deleted: 0, unreconciled: archivedOk.map(m => m.id), degraded: true };
      }

      const unreconciledIds = new Set(deleteResult.unreconciled);
      for (const memory of archivedOk) {
        // Only memories whose vector delete was confirmed (and SQLite row
        // actually removed) get a FORGET audit entry; unreconciled memories
        // are still present and should not be logged as deleted.
        if (unreconciledIds.has(memory.id)) continue;
        this.storage.logAudit('FORGET', memory.id, memory.namespace, 'system', {
          flush: false,
          details: {
            memory_id: memory.id,
            prior_tier: memory.retention_tier,
            new_tier: null,
            actor: 'system',
            timestamp: nowIso,
            action: 'delete',
          },
        });
      }

      this.storage.sqlite.flushIfDirty();

      const degraded = deleteResult.degraded || archiveFailed;
      this.storage.sqlite.setRetentionDegraded(
        degraded,
        degraded ? 'Last cleanup (GC) run reported a partial failure' : null,
        nowIso,
      );

      const compacted = await this.maybeCompact(archivedOk, unreconciledIds, nowIso);

      const durationMs = Date.now() - gcStart;
      this.metrics?.recordHistogram('bhgbrain_gc_duration_ms', durationMs);
      this.metrics?.incCounter('bhgbrain_gc_deleted_total', deleteResult.deleted);
      this.metrics?.incCounter('bhgbrain_gc_archived_total', archived);
      if (compacted.length > 0) {
        this.metrics?.incCounter('bhgbrain_gc_compactions_total', compacted.length);
      }

      this.logger?.info({
        event: 'retention_gc',
        outcome: degraded ? 'degraded' : 'ok',
        scanned: deletable.length,
        archived,
        deleted: deleteResult.deleted,
        degraded,
        unreconciled: deleteResult.unreconciled.length,
        review_candidates: reviewCandidateSummaries.length,
        compacted: compacted.length,
        duration_ms: durationMs,
      });

      return {
        scanned: deletable.length,
        archived,
        deleted: deleteResult.deleted,
        degraded,
        unreconciled: deleteResult.unreconciled,
        candidates,
        reviewCandidates: reviewCandidateSummaries,
        compacted,
      };
    } catch (err) {
      // A truly unexpected failure (not one of the per-item catches above):
      // preserve whatever was already archived/flushed, surface degraded
      // health, and return a well-formed result instead of throwing a raw
      // error out of the scheduler or CLI.
      this.storage.sqlite.flushIfDirty();
      this.storage.sqlite.setRetentionDegraded(true, (err as Error).message, nowIso);
      this.logger?.info({
        event: 'retention_gc',
        outcome: 'degraded',
        error: (err as Error).message,
        scanned: deletable.length,
        archived,
        deleted: 0,
        degraded: true,
      });
      return {
        scanned: deletable.length,
        archived,
        deleted: 0,
        degraded: true,
        unreconciled: deletable.map(m => m.id),
        candidates,
        reviewCandidates: reviewCandidateSummaries,
        compacted: [],
      };
    } finally {
      this.storage.sqlite.endLifecycleOperation('gc');
    }
  }

  /**
   * Threshold-driven compaction (design: "Compaction is threshold-driven, not
   * per-delete"). For each namespace/collection this GC run touched, compares
   * confirmed-deleted count against the collection's remaining point count;
   * once the deleted ratio crosses `compaction_deleted_threshold`, nudges
   * Qdrant's optimizer via `QdrantStore.compact`.
   */
  private async maybeCompact(
    deletedMemories: Array<Pick<MemoryRecord, 'id' | 'namespace' | 'collection'>>,
    unreconciledIds: Set<string>,
    nowIso: string,
  ): Promise<string[]> {
    const threshold = this.config.retention.compaction_deleted_threshold;
    const deletedByCollection = new Map<string, { namespace: string; collection: string; count: number }>();

    for (const memory of deletedMemories) {
      if (unreconciledIds.has(memory.id)) continue;
      const key = `${memory.namespace}|${memory.collection}`;
      const entry = deletedByCollection.get(key);
      if (entry) {
        entry.count++;
      } else {
        deletedByCollection.set(key, { namespace: memory.namespace, collection: memory.collection, count: 1 });
      }
    }

    const compacted: string[] = [];
    for (const { namespace, collection, count } of deletedByCollection.values()) {
      const info = await this.storage.qdrant.getCollectionInfo(namespace, collection);
      const remaining = info?.points_count ?? 0;
      const ratio = count + remaining > 0 ? count / (count + remaining) : 0;
      if (ratio < threshold) continue;

      await this.storage.qdrant.compact(namespace, collection, threshold);
      const key = `${namespace}/${collection}`;
      compacted.push(key);
      this.logger?.info({
        event: 'retention_gc_compaction',
        namespace,
        collection,
        deleted_ratio: ratio,
        threshold,
        timestamp: nowIso,
      });
    }

    return compacted;
  }

  markStaleMemories(): number {
    const decayDays = this.config.retention?.decay_after_days ?? 180;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - decayDays);
    const staleIds = this.storage.sqlite.listStaleCandidateIds(cutoff.toISOString());
    for (const id of staleIds) {
      this.storage.sqlite.markStale(id);
    }
    this.storage.sqlite.flushIfDirty();
    this.logger?.info({
      event: 'retention_stale_marked',
      outcome: 'ok',
      stale_marked: staleIds.length,
    });
    return staleIds.length;
  }

  runConsolidation(): { staleMarked: number; lowImportanceCandidates: number } {
    const staleMarked = this.markStaleMemories();
    const lowImportanceCandidates = this.storage.sqlite.getStaleMemories(0.5, 100).length;
    this.logger?.info({
      event: 'retention_consolidation',
      outcome: 'ok',
      stale_marked: staleMarked,
      low_importance_candidates: lowImportanceCandidates,
    });
    return { staleMarked, lowImportanceCandidates };
  }

  getTierStats(): { counts: Record<RetentionTier, number>; archived: number; unsynced_vectors: number } {
    return {
      counts: this.storage.sqlite.countByTier(),
      archived: this.storage.sqlite.countArchivedMemories(),
      unsynced_vectors: this.storage.sqlite.countUnsyncedVectors(),
    };
  }

  listExpiringSoon(limit = 50): Array<Omit<MemoryRecord, 'embedding'>> {
    const now = new Date();
    const until = new Date(now.getTime() + (this.config.retention.pre_expiry_warning_days * 24 * 60 * 60 * 1000));
    return this.storage.sqlite.listExpiringMemories(now.toISOString(), until.toISOString(), limit);
  }

  listArchive(limit = 50): ArchiveRecord[] {
    return this.storage.sqlite.listArchive(limit);
  }

  searchArchive(query: string, limit = 20): ArchiveRecord[] {
    return this.storage.sqlite.searchArchive(query, limit);
  }

  buildMetadataForTier(tier: RetentionTier) {
    return this.lifecycle.buildMetadata(tier, new Date());
  }

  async restoreArchive(memoryId: string): Promise<{ restored: boolean; id: string }> {
    const archived = this.storage.sqlite.getArchiveByMemoryId(memoryId);
    if (!archived) {
      return { restored: false, id: memoryId };
    }

    const now = new Date().toISOString();
    const metadata = this.lifecycle.buildMetadata(archived.tier, new Date(now));
    const memory: Omit<MemoryRecord, 'embedding'> = {
      id: archived.memory_id || uuidv4(),
      namespace: archived.namespace,
      collection: 'general',
      type: 'semantic',
      category: null,
      content: archived.summary,
      summary: archived.summary,
      tags: archived.tags,
      source: 'cli',
      checksum: archived.memory_id,
      importance: 0.5,
      retention_tier: archived.tier,
      expires_at: metadata.expires_at,
      decay_eligible: metadata.decay_eligible,
      review_due: metadata.review_due,
      access_count: 0,
      last_operation: 'ADD',
      merged_from: null,
      archived: false,
      vector_synced: true,
      created_at: now,
      updated_at: now,
      last_accessed: now,
    };
    const vector = await this.storage.embedding.embed(memory.content);
    await this.storage.writeMemory(memory, vector);
    this.storage.sqlite.deleteArchive(memoryId);
    this.storage.logAudit('RESTORE', memory.id, memory.namespace, 'system', {
      details: {
        memory_id: memory.id,
        prior_tier: null,
        new_tier: archived.tier,
        actor: 'system',
        timestamp: now,
        action: 'restore',
      },
    });
    this.storage.sqlite.flushIfDirty();
    return { restored: true, id: memory.id };
  }
}
