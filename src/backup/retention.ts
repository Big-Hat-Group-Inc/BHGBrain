import type { BrainConfig } from '../config/index.js';
import type { StorageManager, DeleteMemoriesResult } from '../storage/index.js';
import type { ArchiveRecord, MemoryRecord, RetentionTier } from '../domain/types.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';
import { buildRestoredMemoryFromArchive } from '../domain/archive-restore.js';
import type { MetricsCollector } from '../health/metrics.js';
import { toLogError } from '../health/logger.js';

type CleanupPageSqlite = {
  listExpiredMemoriesPage?: (
    nowIso: string, limit: number, cursor?: string, tier?: RetentionTier,
  ) => Array<Omit<MemoryRecord, 'embedding'>>;
  countExpiredDeletableMemories?: (nowIso: string, tier?: RetentionTier) => number;
};

export interface GarbageCollectionResult {
  scanned: number;
  // Eligible T2/T3 rows left after this bounded pass. A true continuation
  // means the scheduler/CLI should invoke another pass to drain the backlog.
  remaining: number;
  continuation: boolean;
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
  // Rows removed from `audit_log` / `memory_revisions` by this run's history
  // pruning (trim-sqlite-query-and-health-overhead), 0 when the corresponding
  // cap is `null` (pruning disabled) or nothing was over the cap.
  audit_pruned: number;
  revisions_pruned: number;
}

export class RetentionService {
  private lifecycle: MemoryLifecycleService;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private logger?: {
      info: (obj: Record<string, unknown>) => void;
      warn?: (obj: Record<string, unknown>) => void;
      error?: (obj: Record<string, unknown>) => void;
    },
    private metrics?: MetricsCollector,
  ) {
    this.lifecycle = new MemoryLifecycleService(config);
  }

  private warn(event: Record<string, unknown>): void {
    if (this.logger?.warn) {
      this.logger.warn(event);
    } else {
      this.logger?.info(event);
    }
  }

  private error(event: Record<string, unknown>): void {
    if (this.logger?.error) {
      this.logger.error(event);
    } else {
      this.warn(event);
    }
  }

  async runGc(options?: { dryRun?: boolean; tier?: RetentionTier }): Promise<GarbageCollectionResult> {
    const nowIso = new Date().toISOString();
    const gcStart = Date.now();

    // Direct archive/delete is restricted to T2/T3. The real store uses a
    // keyset page; the legacy branch keeps narrow test doubles compatible.
    const pageSize = this.config.retention.cleanup_batch_size ?? 200;
    const maxDurationMs = this.config.retention.cleanup_max_duration_ms ?? 30_000;
    const pagedSqlite = this.storage.sqlite as typeof this.storage.sqlite & CleanupPageSqlite;
    const deletable = pagedSqlite.listExpiredMemoriesPage
      ? pagedSqlite.listExpiredMemoriesPage(nowIso, pageSize, undefined, options?.tier)
      : this.storage.sqlite.listExpiredMemories(nowIso, options?.tier).filter(
        memory => memory.retention_tier === 'T2' || memory.retention_tier === 'T3',
      );
    const remainingAfterPass = () => pagedSqlite.countExpiredDeletableMemories
      ? pagedSqlite.countExpiredDeletableMemories(nowIso, options?.tier)
      : 0;
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
      const remaining = Math.max(0, remainingAfterPass() - deletable.length);
      this.logger?.info({
        event: 'retention_gc',
        outcome: 'dry_run',
        scanned: deletable.length,
        remaining,
        continuation: remaining > 0,
        archived: 0,
        deleted: 0,
        degraded: false,
        review_candidates: reviewCandidateSummaries.length,
      });
      return {
        scanned: deletable.length,
        remaining,
        continuation: remaining > 0,
        archived: 0,
        deleted: 0,
        degraded: false,
        unreconciled: [],
        candidates,
        reviewCandidates: reviewCandidateSummaries,
        compacted: [],
        audit_pruned: 0,
        revisions_pruned: 0,
      };
    }

    // Bracket the destructive phase so a crash mid-run is always visible as
    // an in-progress lifecycle operation (mirrors the restore path), and
    // guarantee the lock is released via `finally` regardless of outcome.
    const lifecycleToken = this.storage.sqlite.beginLifecycleOperation('gc');
    let archived = 0;
    let archiveFailed = false;
    let timeBudgetReached = false;
    const archivedOk: typeof deletable = [];

    try {
      for (const memory of deletable) {
        if (Date.now() - gcStart >= maxDurationMs) {
          timeBudgetReached = true;
          break;
        }
        if (!this.config.retention.archive_before_delete) {
          archivedOk.push(memory);
          continue;
        }
        try {
          this.storage.sqlite.archiveMemory(memory, nowIso, lifecycleToken);
          archived++;
          this.storage.logAudit('ARCHIVE', memory.id, memory.namespace, 'system', {
            flush: false,
            lifecycleToken,
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
          this.warn({
            event: 'retention_gc_archive_failed',
            memory_id: memory.id,
            err,
          });
        }
      }

      let deleteResult: DeleteMemoriesResult;
      try {
        deleteResult = await this.storage.deleteMemories(archivedOk, { flush: false, lifecycleToken });
      } catch (err) {
        this.warn({ event: 'retention_gc_delete_failed', err });
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
          lifecycleToken,
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

      // History-table pruning (trim-sqlite-query-and-health-overhead task 4.4):
      // runs inside GC's destructive phase, before the flush/degraded-state
      // bookkeeping below, so it inherits GC's lifecycle bracketing and dry-run
      // exclusion (the dryRun branch returns above without reaching here).
      // `null` disables the corresponding prune.
      const auditCap = this.config.retention.audit_log_max_entries;
      const auditPruned = auditCap !== null ? this.storage.sqlite.pruneAuditLog(auditCap, lifecycleToken) : 0;
      const revisionsCap = this.config.retention.revisions_per_memory_max;
      const revisionsPruned = revisionsCap !== null ? this.storage.sqlite.pruneRevisions(revisionsCap, lifecycleToken) : 0;

      this.storage.sqlite.flushIfDirty();

      const degraded = deleteResult.degraded || archiveFailed;
      this.storage.sqlite.setRetentionDegraded(
        degraded,
        degraded ? 'Last cleanup (GC) run reported a partial failure' : null,
        nowIso,
        lifecycleToken,
      );

      const compacted = await this.maybeCompact(archivedOk, unreconciledIds, nowIso);
      const remaining = remainingAfterPass();
      const continuation = remaining > 0 || timeBudgetReached;

      const durationMs = Date.now() - gcStart;
      this.metrics?.recordHistogram('bhgbrain_gc_duration_ms', durationMs);
      this.metrics?.incCounter('bhgbrain_gc_deleted_total', deleteResult.deleted);
      this.metrics?.incCounter('bhgbrain_gc_archived_total', archived);
      if (compacted.length > 0) {
        this.metrics?.incCounter('bhgbrain_gc_compactions_total', compacted.length);
      }

      (degraded ? this.warn.bind(this) : this.logger?.info.bind(this.logger))?.({
        event: 'retention_gc',
        outcome: degraded ? 'degraded' : 'ok',
        scanned: deletable.length,
        remaining,
        continuation,
        archived,
        deleted: deleteResult.deleted,
        degraded,
        unreconciled: deleteResult.unreconciled.length,
        review_candidates: reviewCandidateSummaries.length,
        compacted: compacted.length,
        duration_ms: durationMs,
        audit_pruned: auditPruned,
        revisions_pruned: revisionsPruned,
      });

      return {
        scanned: deletable.length,
        remaining,
        continuation,
        archived,
        deleted: deleteResult.deleted,
        degraded,
        unreconciled: deleteResult.unreconciled,
        candidates,
        reviewCandidates: reviewCandidateSummaries,
        compacted,
        audit_pruned: auditPruned,
        revisions_pruned: revisionsPruned,
      };
    } catch (err) {
      // A truly unexpected failure (not one of the per-item catches above):
      // preserve whatever was already archived/flushed, surface degraded
      // health, and return a well-formed result instead of throwing a raw
      // error out of the scheduler or CLI.
      this.storage.sqlite.flushIfDirty();
      try {
        this.storage.sqlite.setRetentionDegraded(true, (err as Error).message, nowIso, lifecycleToken);
      } catch (stateError) {
        this.error({
          event: 'retention_gc_state_record_failed',
          err: stateError,
          original_error: toLogError(err).message,
        });
      }
      this.warn({
        event: 'retention_gc',
        outcome: 'degraded',
        err,
        scanned: deletable.length,
        remaining: remainingAfterPass(),
        continuation: true,
        archived,
        deleted: 0,
        degraded: true,
      });
      return {
        scanned: deletable.length,
        remaining: remainingAfterPass(),
        continuation: true,
        archived,
        deleted: 0,
        degraded: true,
        unreconciled: deletable.map(m => m.id),
        candidates,
        reviewCandidates: reviewCandidateSummaries,
        compacted: [],
        audit_pruned: 0,
        revisions_pruned: 0,
      };
    } finally {
      this.storage.sqlite.endLifecycleOperation(lifecycleToken, 'gc');
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
      let info: { points_count: number } | null;
      try {
        info = await this.storage.qdrant.getCollectionInfo(namespace, collection);
      } catch (err) {
        this.warn({
          event: 'retention_gc_collection_info_failed',
          namespace,
          collection,
          err,
        });
        continue;
      }
      const remaining = info?.points_count ?? 0;
      const ratio = count + remaining > 0 ? count / (count + remaining) : 0;
      if (ratio < threshold) continue;

      await this.storage.qdrant.compact(namespace, collection, threshold);
      const key = `${namespace}/${collection}`;
      compacted.push(key);
      this.warn({
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

  async restoreArchive(
    memoryId: string,
  ): Promise<{ restored: boolean; id: string; restored_from?: string; archive_id?: number }> {
    const archived = this.storage.sqlite.getArchiveByMemoryId(memoryId);
    if (!archived) {
      return { restored: false, id: memoryId };
    }

    // Shared with the `review` MCP tool's `restore` action (src/tools/index.ts)
    // so checksum, expiry/review, and provenance fields cannot drift between
    // the CLI and tool entrypoints — see
    // openspec/changes/make-backup-restore-transactional (task 2.4). An
    // earlier version of this method derived `checksum` from
    // `archived.memory_id` (an unrelated identifier) rather than the
    // restored content.
    const memory = buildRestoredMemoryFromArchive(this.config, archived, { source: 'cli' });
    const vector = await this.storage.embedding.embed(memory.content);
    await this.storage.writeMemory(memory, vector);
    // Archive row is retained (not deleted) so the origin stays inspectable,
    // matching the `review` tool's restore behavior.
    this.storage.logAudit('RESTORE', memory.id, memory.namespace, 'system', {
      details: {
        memory_id: memory.id,
        prior_tier: null,
        new_tier: archived.tier,
        actor: 'system',
        timestamp: memory.created_at,
        action: 'restore',
      },
    });
    this.storage.sqlite.flushIfDirty();
    return { restored: true, id: memory.id, restored_from: archived.memory_id, archive_id: archived.id };
  }
}
