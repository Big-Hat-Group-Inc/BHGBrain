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

    const { clusters, clustersFound } = await this.findClusters();

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
    });

    return { clustersFound, distilled, skipped, archived, degraded, candidates };
  }

  /**
   * Scans every namespace/collection currently holding T2/T3 episodic
   * memories, clusters each collection's candidates independently (see
   * design.md Decision #3), then merges and globally caps the result to
   * `max_clusters_per_run` — largest clusters first — so the run-wide LLM
   * call budget is respected regardless of how many collections qualify.
   */
  private async findClusters(): Promise<{ clusters: InternalCluster[]; clustersFound: number }> {
    const cfg = this.config.retention.distillation;
    const pairs = this.storage.sqlite.listDistillationCollections();

    const perCollection: InternalCluster[] = [];
    for (const { namespace, collection } of pairs) {
      const points = await this.storage.qdrant.scrollCollection(namespace, collection, 100, true);
      const candidates: ClusterCandidate[] = [];
      for (const point of points) {
        const type = point.payload.type;
        const tier = point.payload.retention_tier;
        if (type !== 'episodic' || (tier !== 'T2' && tier !== 'T3')) continue;
        if (!point.vector) continue;
        candidates.push({ id: point.id, vector: point.vector });
      }

      const clusters = clusterEpisodicMemories(candidates, {
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
    return { clusters: perCollection.slice(0, cfg.max_clusters_per_run), clustersFound: perCollection.length };
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
