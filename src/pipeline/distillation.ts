import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { WritePipeline } from './index.js';
import type { MetricsCollector } from '../health/metrics.js';
import { clusterEpisodicMemories, type ClusterCandidate } from './distillation-cluster.js';
import { DistillationLLMError, type DistillationLLMClient } from './distillation-llm.js';

export type DistillationSkipReason = 'no_key' | 'llm_error' | 'write_failed';

export interface DistillationCandidateCluster {
  namespace: string;
  collection: string;
  ids: string[];
  summaries: string[];
}

export interface DistillationResult {
  clustersFound: number;
  distilled: number;
  skipped: Array<{ reason: DistillationSkipReason; count: number }>;
  archived: number;
  // true when a distilled write's source archival/deletion could not be
  // fully confirmed — mirrors GarbageCollectionResult's `degraded`. The
  // distilled write itself is never rolled back (see design.md Decision #4).
  degraded: boolean;
  candidates: DistillationCandidateCluster[];
  // Eligible T2/T3 episodic candidates left out of this run's clustering
  // pass because a collection's candidate count exceeded
  // `retention.distillation.max_candidates_per_collection` — never silently
  // dropped, and rotated into a future run's window (see `findClusters`'s
  // deterministic cursor). See bound-corpus-scale-workflows task 2.1.
  candidatesSkipped: number;
}

interface InternalCluster {
  namespace: string;
  collection: string;
  ids: string[];
}

/**
 * The "sleep" job: clusters related, still-active T2/T3 episodic memories
 * per namespace/collection and consolidates each qualifying cluster into one
 * durable T1 semantic memory via `DistillationLLMClient`, archiving the
 * cluster's sources only after the consolidated memory is confirmed
 * durable. Structurally mirrors `RetentionService` (`src/backup/
 * retention.ts`): a `runOnce`, a typed result mirroring
 * `GarbageCollectionResult`, and the same archive-after-durable-write
 * discipline. See add-memory-distillation.
 */
export class DistillationService {
  constructor(
    private readonly config: BrainConfig,
    private readonly storage: StorageManager,
    private readonly pipeline: WritePipeline,
    private readonly llmClient: DistillationLLMClient,
    private readonly logger?: {
      info: (obj: Record<string, unknown>) => void;
      warn?: (obj: Record<string, unknown>) => void;
    },
    private readonly metrics?: MetricsCollector,
  ) {}

  async runOnce(options?: { dryRun?: boolean }): Promise<DistillationResult> {
    const dryRun = options?.dryRun ?? false;
    const start = Date.now();
    const cfg = this.config.retention.distillation;

    const { clusters, clustersFound, candidatesSkipped } = await this.findClusters();

    const candidates: DistillationCandidateCluster[] = [];
    const skippedByReason = new Map<DistillationSkipReason, number>();
    let distilled = 0;
    let archived = 0;
    let degraded = false;

    const bumpSkipped = (reason: DistillationSkipReason): void => {
      skippedByReason.set(reason, (skippedByReason.get(reason) ?? 0) + 1);
    };

    for (const cluster of clusters) {
      const records = this.storage.sqlite.getMemoriesByIds(cluster.ids)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at));

      // A record may have vanished between clustering and processing (e.g.
      // GC or a prior cluster in this same run already archived it via
      // overlapping membership) — a cluster that has dropped below the
      // configured minimum is no longer a qualifying cluster.
      if (records.length < cfg.min_cluster_size) {
        continue;
      }

      candidates.push({
        namespace: cluster.namespace,
        collection: cluster.collection,
        ids: records.map(r => r.id),
        summaries: records.map(r => r.summary),
      });

      if (dryRun) {
        continue;
      }

      let output: { content: string; summary: string };
      try {
        output = await this.llmClient.distill(
          records.map(r => ({ content: r.content, updated_at: r.updated_at })),
        );
      } catch (err) {
        const reason: DistillationSkipReason = err instanceof DistillationLLMError ? err.reason : 'llm_error';
        bumpSkipped(reason);
        this.logger?.warn?.({
          event: 'distillation_cluster_skipped',
          namespace: cluster.namespace,
          collection: cluster.collection,
          reason,
          cluster_size: records.length,
          error: (err as Error).message,
        });
        continue;
      }

      const tags = [...new Set(records.flatMap(r => r.tags))];
      const importance = Math.max(...records.map(r => r.importance));
      const sourceIds = records.map(r => r.id);

      let newMemoryId: string | undefined;
      try {
        const results = await this.pipeline.process({
          content: output.content,
          namespace: cluster.namespace,
          collection: cluster.collection,
          type: 'semantic',
          tags,
          importance,
          source: 'distillation',
          retention_tier: 'T1',
          derived_from: sourceIds,
          clientId: 'distillation-scheduler',
        });
        newMemoryId = results[0]?.id;
      } catch (err) {
        bumpSkipped('write_failed');
        this.logger?.warn?.({
          event: 'distillation_write_failed',
          namespace: cluster.namespace,
          collection: cluster.collection,
          error: (err as Error).message,
        });
        continue;
      }

      if (!newMemoryId) {
        bumpSkipped('write_failed');
        continue;
      }

      distilled++;

      const archiveResult = await this.archiveSources(sourceIds, newMemoryId, cluster.namespace);
      archived += archiveResult.archived;
      if (archiveResult.degraded) degraded = true;
    }

    const skipped = [...skippedByReason.entries()].map(([reason, count]) => ({ reason, count }));
    const totalSkipped = skipped.reduce((sum, s) => sum + s.count, 0);

    if (!dryRun) {
      this.storage.sqlite.recordDistillationRun({ distilled, skipped: totalSkipped, degraded });
      this.storage.sqlite.flushIfDirty();
    }

    const durationMs = Date.now() - start;
    this.metrics?.recordHistogram('bhgbrain_distill_duration_ms', durationMs);
    this.metrics?.incCounter('bhgbrain_distill_clusters_found_total', clustersFound);
    this.metrics?.incCounter('bhgbrain_distill_distilled_total', distilled);
    this.metrics?.incCounter('bhgbrain_distill_archived_total', archived);
    for (const { reason, count } of skipped) {
      this.metrics?.incCounter('bhgbrain_distill_skipped_total', count, { reason });
    }

    this.logger?.info({
      event: 'distillation_run',
      outcome: dryRun ? 'dry_run' : (degraded ? 'degraded' : 'ok'),
      clusters_found: clustersFound,
      distilled,
      skipped: totalSkipped,
      archived,
      degraded,
      duration_ms: durationMs,
      candidates_skipped: candidatesSkipped,
    });

    return { clustersFound, distilled, skipped, archived, degraded, candidates, candidatesSkipped };
  }

  /**
   * Scans every namespace/collection currently holding T2/T3 episodic
   * memories, clusters each collection's candidates independently (see
   * design.md Decision #3), then merges and globally caps the result to
   * `max_clusters_per_run` — largest clusters first — so the run-wide LLM
   * call budget is respected regardless of how many collections qualify.
   *
   * Each collection is scanned page-by-page via `scrollCollectionPages`
   * (bound-corpus-scale-workflows task 1.2) with a payload projection
   * limited to the two fields this scan actually inspects (`type`,
   * `retention_tier`) rather than every stored field, and clustering itself
   * is bounded per collection to at most `max_candidates_per_collection`
   * candidates (task 2.1) — pairwise similarity is O(n^2), so an unbounded
   * candidate set would make one run's compute cost scale quadratically with
   * corpus size. When a collection has more eligible candidates than the
   * cap, a deterministic (sorted-by-id) window starting at that collection's
   * persisted rotation cursor is clustered, the rest are counted and
   * reported as skipped (never silently dropped), and the cursor advances
   * so a later run's window covers the next slice — eventually rotating
   * through the whole candidate pool instead of only ever reprocessing the
   * same prefix.
   */
  private async findClusters(): Promise<{
    clusters: InternalCluster[];
    clustersFound: number;
    candidatesSkipped: number;
  }> {
    const cfg = this.config.retention.distillation;
    const pairs = this.storage.sqlite.listDistillationCollections();

    const perCollection: InternalCluster[] = [];
    let candidatesSkipped = 0;
    for (const { namespace, collection } of pairs) {
      const candidates: ClusterCandidate[] = [];
      for await (const page of this.storage.qdrant.scrollCollectionPages(namespace, collection, {
        batchSize: 100,
        withVector: true,
        payloadFields: ['type', 'retention_tier'],
      })) {
        for (const point of page.points) {
          const type = point.payload.type;
          const tier = point.payload.retention_tier;
          if (type !== 'episodic' || (tier !== 'T2' && tier !== 'T3')) continue;
          if (!point.vector) continue;
          candidates.push({ id: point.id, vector: point.vector });
        }
      }

      // Deterministic order (independent of Qdrant's internal scroll
      // ordering) so the cap window below, and the cursor it advances, are
      // reproducible across runs.
      candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      const windowed = this.applyCandidateCap(namespace, collection, candidates, cfg.max_candidates_per_collection);
      candidatesSkipped += candidates.length - windowed.length;

      const clusters = await clusterEpisodicMemories(windowed, {
        similarityThreshold: cfg.similarity_threshold,
        minClusterSize: cfg.min_cluster_size,
        maxClusterSize: cfg.max_cluster_size,
        // Uncapped here: the run-wide cap is applied once below, across
        // every collection's clusters together.
        maxClustersPerRun: Number.MAX_SAFE_INTEGER,
      });

      for (const ids of clusters) {
        perCollection.push({ namespace, collection, ids });
      }
    }

    perCollection.sort((a, b) => b.ids.length - a.ids.length);
    return {
      clusters: perCollection.slice(0, cfg.max_clusters_per_run),
      clustersFound: perCollection.length,
      candidatesSkipped,
    };
  }

  /**
   * Bounds one collection's candidate set to `cap` before pairwise
   * similarity ever runs (design.md Decision #2), selecting a deterministic
   * circular window starting at the collection's persisted rotation cursor
   * and advancing that cursor for the next run. A collection at or under
   * the cap resets its cursor to 0 rather than leaving it stale, so a later
   * regrowth starts rotating from the top instead of resuming mid-pool at
   * an offset that may no longer even be in range.
   */
  private applyCandidateCap(
    namespace: string,
    collection: string,
    candidates: ClusterCandidate[],
    cap: number,
  ): ClusterCandidate[] {
    if (candidates.length <= cap) {
      this.storage.sqlite.setDistillationCursor(namespace, collection, 0);
      return candidates;
    }

    const offset = this.storage.sqlite.getDistillationCursor(namespace, collection) % candidates.length;
    const windowed: ClusterCandidate[] = [];
    for (let i = 0; i < cap; i++) {
      windowed.push(candidates[(offset + i) % candidates.length]!);
    }
    const skipped = candidates.length - windowed.length;

    this.metrics?.incCounter('bhgbrain_distill_candidates_skipped_total', skipped, { namespace, collection });
    this.logger?.warn?.({
      event: 'distillation_candidates_capped',
      namespace,
      collection,
      total_candidates: candidates.length,
      window_size: windowed.length,
      skipped,
      cursor_offset: offset,
    });
    this.storage.sqlite.setDistillationCursor(namespace, collection, (offset + cap) % candidates.length);

    return windowed;
  }

  /**
   * Archives and deletes a distilled cluster's source memories, mirroring
   * `RetentionService.runGc`'s archive-then-delete discipline
   * (`src/backup/retention.ts:109-168`). Never rolls back the already-durable
   * distilled write on failure here — a still-active source is safe (the
   * next clustering run may re-cluster it, and `WritePipeline.process`'s
   * dedup UPDATEs rather than duplicates the T1 memory).
   */
  private async archiveSources(
    sourceIds: string[],
    newMemoryId: string,
    namespace: string,
  ): Promise<{ archived: number; degraded: boolean }> {
    // Defensive: never archive the memory distillation just wrote, in the
    // unlikely event a source id collided with it.
    const idsToArchive = sourceIds.filter(id => id !== newMemoryId);
    const records = this.storage.sqlite.getMemoriesByIds(idsToArchive);
    if (records.length === 0) {
      return { archived: 0, degraded: false };
    }

    const nowIso = new Date().toISOString();
    let archiveFailed = false;
    const archivedOk: typeof records = [];
    for (const record of records) {
      try {
        this.storage.sqlite.archiveMemory(record, nowIso);
        archivedOk.push(record);
      } catch (err) {
        archiveFailed = true;
        this.logger?.warn?.({
          event: 'distillation_archive_failed',
          memory_id: record.id,
          error: (err as Error).message,
        });
      }
    }

    let deleted = 0;
    let deleteDegraded = false;
    try {
      const deleteResult = await this.storage.deleteMemories(archivedOk, { flush: false });
      deleted = deleteResult.deleted;
      deleteDegraded = deleteResult.degraded;
    } catch (err) {
      deleteDegraded = true;
      this.logger?.warn?.({
        event: 'distillation_delete_failed',
        namespace,
        error: (err as Error).message,
      });
    }

    this.storage.logAudit('DISTILL', newMemoryId, namespace, 'system', {
      flush: false,
      details: {
        memory_id: newMemoryId,
        prior_tier: null,
        new_tier: 'T1',
        actor: 'system',
        timestamp: nowIso,
        action: 'distill',
        derived_from: idsToArchive,
      },
    });
    this.storage.sqlite.flushIfDirty();

    return { archived: deleted, degraded: archiveFailed || deleteDegraded };
  }
}
