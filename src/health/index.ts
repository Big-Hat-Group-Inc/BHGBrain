import type pino from 'pino';
import type { BrainConfig } from '../config/index.js';
import type { HealthSnapshot, HealthStatus, ComponentHealth, VectorReconciliationStatus, CapacityHealth, VectorDriftCause } from '../domain/types.js';
import type { StorageManager } from '../storage/index.js';
import { DegradedEmbeddingProvider, type EmbeddingProvider } from '../embedding/index.js';
import type { RetentionTier } from '../domain/types.js';
import type { CircuitBreaker } from '../resilience/index.js';

const startTime = Date.now();

interface SqliteStatsSnapshot {
  countsByTier: Record<RetentionTier, number>;
  unsyncedVectors: number;
  memoryCount: number;
  dbSizeBytes: number;
  expiringSoon: number;
  archivedCount: number;
}

interface SchedulerHealthState {
  armed: boolean;
  last_run_at: string | null;
  failure: string | null;
}

/**
 * bound-qdrant-http-runtime task 2.1: the terse public `/health/live`
 * response — process responsiveness only, no dependency I/O at all.
 */
export interface LivenessSnapshot {
  status: 'ok';
  uptime_seconds: number;
}

/**
 * bound-qdrant-http-runtime task 2.1: the public `/health/ready` response —
 * required storage dependencies only (SQLite + Qdrant), with the Qdrant probe
 * cached (see `checkQdrant`'s `cachedQdrantHealth`) so repeated unauthenticated
 * probes cannot each start a fresh, uncached Qdrant request. `ready: false`
 * maps to HTTP 503 at the transport layer.
 */
export interface ReadinessSnapshot {
  ready: boolean;
  components: {
    sqlite: ComponentHealth;
    qdrant: ComponentHealth;
  };
}

export class HealthService {
  private cachedEmbeddingHealth: ComponentHealth | null = null;
  private cachedEmbeddingAt = 0;
  private static readonly EMBEDDING_CACHE_MS = 30_000; // cache for 30s

  // trim-sqlite-query-and-health-overhead task 5.2: `/health` bypasses auth
  // (src/transport/middleware.ts) and its handler recomputes everything per
  // request, so unauthenticated poll storms would otherwise re-run every
  // SQLite aggregate on every request. A short TTL (well inside any real
  // monitoring poll interval) absorbs that while keeping numbers near-live.
  // Component *statuses* derived from lifecycle/degraded flags (not from
  // these counts) are read fresh every call regardless — see
  // `checkRetention`/`checkVectorReconciliation`.
  private cachedSqliteStats: SqliteStatsSnapshot | null = null;
  private cachedSqliteStatsAt = 0;
  private static readonly SQLITE_STATS_CACHE_MS = 5_000; // cache for 5s

  // bound-qdrant-http-runtime task 2.1/2.2: `checkQdrant()` is a live network
  // call with no cache of its own. Both the authenticated diagnostic
  // `/health` route and the public, rate-limited `/health/ready` route call
  // it — without a cache, a burst of unauthenticated readiness probes would
  // each start a fresh, uncached Qdrant request (the exact amplification the
  // "Health SHALL distinguish liveness, readiness, and diagnostics"
  // requirement rules out). Mirrors `cachedEmbeddingHealth`'s pattern above.
  private cachedQdrantHealth: ComponentHealth | null = null;
  private cachedQdrantAt = 0;
  private static readonly QDRANT_HEALTH_CACHE_MS = 5_000; // cache for 5s

  // strengthen-operational-observability task 3.2: `getTotalManagedPointsCount()`
  // is an N-collection scan (one Qdrant round trip per managed collection),
  // not a cheap local read like the caches above — cached for a full minute
  // so it amortizes across many /health polls instead of running on every
  // one. See `getCachedQdrantPointsTotal`.
  private cachedQdrantPointsTotal: { total: number; at: number } | null = null;
  private static readonly VECTOR_COUNT_CACHE_MS = 60_000; // cache for 60s
  // A small fixed allowance before a Qdrant-vs-SQLite count mismatch is
  // reported as suspected surplus — normal write-path timing (a vector
  // upserted just before its SQLite row commits, or vice versa) can produce
  // a transient off-by-a-few difference that is not actually drift.
  private static readonly VECTOR_SURPLUS_TOLERANCE = 3;

  constructor(
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
    private config: BrainConfig,
    private breakers: Record<string, CircuitBreaker> = {},
    private logger?: pino.Logger,
    private schedulerStates?: () => SchedulerHealthState[],
  ) {}

  /**
   * bound-qdrant-http-runtime task 2.1: the public `/health/live` response.
   * Deliberately synchronous and dependency-free — no SQLite read, no Qdrant
   * call, no cache lookup even — so it stays cheap under any probe rate and
   * reflects only "the process is alive and its event loop is responsive
   * enough to answer this request", matching the "terse unauthenticated
   * liveness response SHALL avoid expensive dependency work" requirement.
   */
  checkLiveness(): LivenessSnapshot {
    return { status: 'ok', uptime_seconds: Math.floor((Date.now() - startTime) / 1000) };
  }

  /**
   * bound-qdrant-http-runtime task 2.1/2.2: the public `/health/ready`
   * response. Checks only the two storage dependencies a request cannot
   * function without (SQLite, Qdrant) — not embedding, retention, or
   * scheduler state, which degrade the server's *quality* rather than its
   * ability to serve requests at all — and both underlying checks are
   * cheap/cached (`checkSqlite` is a local `SELECT 1`; `checkQdrant` is
   * cached for `QDRANT_HEALTH_CACHE_MS`), so a burst of public probes never
   * translates into a burst of fresh dependency calls.
   */
  async checkReadiness(): Promise<ReadinessSnapshot> {
    const [sqlite, qdrant] = await Promise.all([
      Promise.resolve(this.checkSqlite()),
      this.checkQdrant(),
    ]);
    const ready = sqlite.status !== 'unhealthy' && qdrant.status !== 'unhealthy';
    return { ready, components: { sqlite, qdrant } };
  }

  async check(): Promise<HealthSnapshot> {
    const [sqliteOk, qdrantOk, embeddingOk] = await Promise.all([
      this.checkSqlite(),
      this.checkQdrant(),
      this.checkEmbedding(),
    ]);
    // Single-pass + short-TTL cache (task 5.1/5.2): `countByTier` and
    // `countUnsyncedVectors` are each computed at most once per (uncached)
    // snapshot, not once for the retention/vector-reconciliation component
    // status and again for the reported stats block.
    const stats = this.getSqliteStats();
    const retentionOk = this.checkRetention(stats.countsByTier);
    const capacityOk = this.checkCapacity(stats);
    const schedulersOk = this.checkSchedulers();
    const vectorReconciliation = await this.checkVectorReconciliation(stats.unsyncedVectors, stats.memoryCount);
    const bootstrapHydrationOk = this.checkBootstrapHydration();

    const overall = this.computeOverall(
      sqliteOk, qdrantOk, embeddingOk, vectorReconciliation, retentionOk, schedulersOk, bootstrapHydrationOk, capacityOk,
    );

    return {
      status: overall,
      components: {
        sqlite: sqliteOk,
        qdrant: qdrantOk,
        embedding: embeddingOk,
        vector_reconciliation: vectorReconciliation,
        retention: retentionOk,
        capacity: capacityOk,
        schedulers: schedulersOk,
        bootstrap_hydration: bootstrapHydrationOk,
      },
      memory_count: stats.memoryCount,
      db_size_bytes: stats.dbSizeBytes,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      circuitBreakers: this.getCircuitBreakerStates(),
      retention: {
        counts_by_tier: stats.countsByTier,
        expiring_soon: stats.expiringSoon,
        archived_count: stats.archivedCount,
        unsynced_vectors: stats.unsyncedVectors,
        over_capacity: this.isOverCapacity(stats.countsByTier),
        cleanup_lag_seconds: this.computeCleanupLagSeconds(new Date()),
        distillation: this.buildDistillationRollup(),
      },
    };
  }

  /**
   * Returns the SQLite stats bundle (tier counts, unsynced-vector count,
   * memory count, DB size, expiring-soon/archived counts), computing every
   * aggregate exactly once and caching the bundle for
   * `SQLITE_STATS_CACHE_MS` (task 5.2), mirroring `checkEmbedding`'s
   * `cachedEmbeddingHealth` pattern above.
   */
  private getSqliteStats(): SqliteStatsSnapshot {
    const now = Date.now();
    if (this.cachedSqliteStats && (now - this.cachedSqliteStatsAt) < HealthService.SQLITE_STATS_CACHE_MS) {
      return this.cachedSqliteStats;
    }
    const nowDate = new Date(now);
    const until = new Date(now + (7 * 24 * 60 * 60 * 1000));
    const stats: SqliteStatsSnapshot = {
      countsByTier: this.storage.sqlite.countByTier(),
      unsyncedVectors: this.storage.sqlite.countUnsyncedVectors(),
      memoryCount: this.storage.sqlite.countMemories(),
      dbSizeBytes: this.storage.sqlite.getDbSizeBytes(),
      expiringSoon: this.storage.sqlite.countExpiringMemories(nowDate.toISOString(), until.toISOString()),
      archivedCount: this.storage.sqlite.countArchivedMemories(),
    };
    this.cachedSqliteStats = stats;
    this.cachedSqliteStatsAt = now;
    return stats;
  }

  // Additive rollup (add-memory-distillation, task 6.2): read straight from
  // the persisted `distillation_state` single-row table (see
  // `SqliteStore.getDistillationState`) so it reflects the last run
  // regardless of which process last ran the scheduled job.
  private buildDistillationRollup(): NonNullable<HealthSnapshot['retention']>['distillation'] {
    const state = this.storage.sqlite.getDistillationState();
    return {
      last_run_at: state.last_run_at,
      last_run_degraded: state.last_run_degraded,
      distilled_total: state.distilled_total,
      skipped_total: state.skipped_total,
    };
  }

  private checkSqlite(): ComponentHealth {
    try {
      const ok = this.storage.sqlite.healthCheck();
      if (!ok) {
        return { status: 'unhealthy', message: 'SQLite health check failed' };
      }
      // openspec/changes/upgrade-fulltext-to-fts5, task 3.3 (visibility half):
      // when the SQLite build lacks the fts5 module, fulltext search runs on the
      // legacy LIKE-based matcher instead of the FTS5/BM25 path. Surface that here
      // rather than silently — the "Missing FTS5 support SHALL degrade gracefully
      // and visibly" spec requirement — while keeping the component healthy. Since
      // migrate-sqlite-to-native-engine, the `node:sqlite` build ships fts5, so
      // `isFts5Available()` is `true` in normal operation and this branch is not
      // the expected steady state anymore; it stays as a visible fallback for any
      // future build that lacks the module.
      if (!this.storage.sqlite.isFts5Available()) {
        return {
          status: 'healthy',
          message: 'Fulltext search is running the legacy LIKE-based matcher: this SQLite build has no fts5 module.',
        };
      }
      return { status: 'healthy' };
    } catch (err) {
      return { status: 'unhealthy', message: (err as Error).message };
    }
  }

  private async checkQdrant(): Promise<ComponentHealth> {
    const now = Date.now();
    if (this.cachedQdrantHealth && (now - this.cachedQdrantAt) < HealthService.QDRANT_HEALTH_CACHE_MS) {
      return this.cachedQdrantHealth;
    }
    try {
      const ok = await this.storage.qdrant.healthCheck();
      this.cachedQdrantHealth = ok
        ? { status: 'healthy' }
        : { status: 'unhealthy', message: 'Qdrant unreachable' };
    } catch (err) {
      const message = (err as Error).message;
      // Log the raw failure reason so an operator reading structured logs can
      // tell a retrieval-path failure (e.g. "this.client.query is not a
      // function") from a plain connectivity failure (e.g. ECONNREFUSED),
      // not just an operator polling /health and reading the message field.
      this.logger?.warn({ event: 'qdrant_health_check_failed', message });
      this.cachedQdrantHealth = { status: 'unhealthy', message };
    }
    this.cachedQdrantAt = now;
    return this.cachedQdrantHealth;
  }

  private async checkEmbedding(): Promise<ComponentHealth> {
    // Identity mismatch takes priority over (and is independent of) the
    // reachability probe below: a store expecting a different embedding
    // identity than the active configuration is degraded even if the
    // currently-configured provider is perfectly reachable — the risk is
    // mixed vector spaces, not connectivity. Cheap (single SQLite read), so
    // it is not subject to the 30s reachability cache below.
    const mismatch = this.checkEmbeddingIdentityMismatch();
    if (mismatch) {
      return mismatch;
    }

    // If running in degraded mode, skip the API call entirely
    if (this.embedding instanceof DegradedEmbeddingProvider) {
      return { status: 'degraded', message: 'Embedding provider unavailable (missing credentials)' };
    }

    // Use cached result if still fresh to avoid per-probe API calls
    const now = Date.now();
    if (this.cachedEmbeddingHealth && (now - this.cachedEmbeddingAt) < HealthService.EMBEDDING_CACHE_MS) {
      return this.cachedEmbeddingHealth;
    }

    try {
      const ok = await this.embedding.healthCheck();
      this.cachedEmbeddingHealth = ok
        ? { status: 'healthy' }
        : { status: 'degraded', message: 'Embedding provider unreachable' };
    } catch (err) {
      this.cachedEmbeddingHealth = { status: 'degraded', message: (err as Error).message };
    }
    this.cachedEmbeddingAt = now;
    return this.cachedEmbeddingHealth;
  }

  private checkEmbeddingIdentityMismatch(): ComponentHealth | null {
    const expected = this.storage.sqlite.getExpectedEmbeddingIdentity();
    if (expected && expected !== this.embedding.identity) {
      return {
        status: 'degraded',
        message: `Embedding identity mismatch: store expects "${expected}" but active configuration ` +
          `is "${this.embedding.identity}". Run the repair tool with mode: "re-embed" to migrate ` +
          `existing vectors, or restore the previous embedding.provider/model configuration.`,
      };
    }
    return null;
  }

  // `null` means cleanup has never completed successfully (a fresh install,
  // or every run so far has failed) rather than "zero lag" — callers should
  // treat null as "unknown", not "just ran".
  private computeCleanupLagSeconds(now: Date): number | null {
    const { last_success_at } = this.storage.sqlite.getRetentionDegraded();
    if (!last_success_at) return null;
    const lastSuccessMs = Date.parse(last_success_at);
    if (Number.isNaN(lastSuccessMs)) return null;
    return Math.max(0, Math.floor((now.getTime() - lastSuccessMs) / 1000));
  }

  private checkRetention(counts: Record<RetentionTier, number>): ComponentHealth {
    // `getRetentionDegraded()` is a single-row read, not an aggregate scan,
    // so it stays live on every call (task 5.2's "component statuses are not
    // cached") — only the tier counts driving `isOverCapacity` come from the
    // shared, possibly-cached snapshot passed in by `check()`.
    const gcState = this.storage.sqlite.getRetentionDegraded();
    if (gcState.degraded) {
      return {
        status: 'degraded',
        message: gcState.message ?? 'Last cleanup (GC) run reported a partial failure',
      };
    }

    if (this.isOverCapacity(counts)) {
      return { status: 'degraded', message: 'Retention tier or total capacity threshold exceeded' };
    }
    return { status: 'healthy' };
  }

  /**
   * strengthen-operational-observability task 3.1: evaluates the configured
   * `retention.max_db_size_gb`/`max_memories` hard caps AND the
   * `retention.warn_at_percent` early-warning threshold against them — the
   * two config fields existed already (config/index.ts) but nothing in the
   * codebase ever read them before this. Degrades at the warning percentage
   * so an operator has advance notice before the hard cap (already enforced
   * separately by `isOverCapacity`/`checkRetention`, which blocks/GCs
   * writes) is ever reached, per the spec scenario "Database exceeds its
   * warning threshold ... health becomes degraded before the hard cap is
   * exceeded".
   */
  private checkCapacity(stats: SqliteStatsSnapshot): CapacityHealth {
    const dbSizeLimitBytes = this.config.retention.max_db_size_gb * 1024 * 1024 * 1024;
    const memoryCountLimit = this.config.retention.max_memories;
    const warnAtPercent = this.config.retention.warn_at_percent;

    const dbSizePercent = dbSizeLimitBytes > 0 ? (stats.dbSizeBytes / dbSizeLimitBytes) * 100 : 0;
    const memoryCountPercent = memoryCountLimit > 0 ? (stats.memoryCount / memoryCountLimit) * 100 : 0;

    const base = {
      db_size_bytes: stats.dbSizeBytes,
      db_size_limit_bytes: dbSizeLimitBytes,
      db_size_percent: Math.round(dbSizePercent * 10) / 10,
      memory_count: stats.memoryCount,
      memory_count_limit: memoryCountLimit,
      memory_count_percent: Math.round(memoryCountPercent * 10) / 10,
    };

    if (stats.dbSizeBytes >= dbSizeLimitBytes || stats.memoryCount >= memoryCountLimit) {
      return {
        ...base,
        status: 'degraded',
        message: `Database has reached its configured capacity limit ` +
          `(size ${base.db_size_percent}% of ${this.config.retention.max_db_size_gb}GB, ` +
          `memories ${base.memory_count_percent}% of ${memoryCountLimit}).`,
      };
    }

    if (dbSizePercent >= warnAtPercent || memoryCountPercent >= warnAtPercent) {
      return {
        ...base,
        status: 'degraded',
        message: `Database is approaching its configured capacity limit ` +
          `(size ${base.db_size_percent}%, memories ${base.memory_count_percent}% — ` +
          `warning threshold is ${warnAtPercent}%).`,
      };
    }

    return { ...base, status: 'healthy' };
  }

  private checkSchedulers(): ComponentHealth {
    const states = this.schedulerStates?.() ?? [];
    const failed = states.find(state => state.failure !== null);
    if (failed) return { status: 'degraded', message: failed.failure ?? 'Scheduler failed' };
    const unarmed = states.find(state => !state.armed);
    if (unarmed) return { status: 'degraded', message: 'A scheduler is not armed' };
    return { status: 'healthy' };
  }

  /**
   * Reports 'degraded' while any Qdrant collection is durably recorded
   * 'failed' in bootstrap_hydration_state — resumable hydration (task 3.1)
   * means a failed collection is retried on a later
   * bootstrapFromQdrant call rather than aborting the whole run, but until
   * that retry actually converges the collection to 'complete', health
   * should visibly reflect that this device's local SQLite copy may still
   * be missing memories the rest of the fleet already has.
   */
  private checkBootstrapHydration(): ComponentHealth {
    const state = this.storage.sqlite.getBootstrapHydrationState();
    const failed = state.filter(row => row.status === 'failed');
    if (failed.length > 0) {
      return {
        status: 'degraded',
        message: `${failed.length} Qdrant collection(s) failed to hydrate and will be retried: ${failed.map(f => f.collection_name).join(', ')}`,
      };
    }
    return { status: 'healthy' };
  }

  /**
   * strengthen-operational-observability task 3.3: a human-readable cause
   * for an on-record vector drift — see `VectorDriftCause` and
   * `BackupService.restoreVectorStateAfterActivation`, which persists it via
   * `SqliteStore.setVectorDriftState` at the moment a restore first detects
   * it, past that call's own one-shot response.
   */
  private static describeDriftCause(cause: VectorDriftCause): string {
    switch (cause) {
      case 'full-rebuild':
        return 'the embedding model or dimensions changed since the last restore, so vectors are being fully rebuilt';
      case 'inspection-failed':
        return 'the vector store could not be inspected for drift during the last restore (a transient failure, not a model change), so reconciliation is conservatively re-embedding the corpus';
      case 'partial-drift':
        return 'a checksum mismatch was found during the last restore; vector reconciliation for the drifted subset is continuing';
    }
  }

  private async checkVectorReconciliation(unsyncedVectors: number, memoryCount: number): Promise<VectorReconciliationStatus> {
    // `getLifecycleOperation()`/`isBackgroundReconciliationActive()` are live
    // in-memory/single-row reads, so the "reconciling" transition is visible
    // immediately regardless of the stats cache above — only `unsyncedVectors`
    // itself (the "pending" vs. "healthy" count) is sourced from the shared
    // snapshot.
    const lifecycleOperation = this.storage.sqlite.getLifecycleOperation();
    // strengthen-operational-observability task 3.3: read once and reused by
    // every branch below that can attribute its degraded state to a
    // specific, persisted cause rather than a generic "reconciliation in
    // progress" message.
    const driftState = this.storage.sqlite.getVectorDriftState();

    if (lifecycleOperation === 'restore') {
      return {
        status: 'degraded',
        state: 'reconciling',
        unsynced_vectors: unsyncedVectors,
        message: 'Restore is active and vector reconciliation is in progress.',
        drift_cause: driftState.cause,
      };
    }

    // Restore releases the lifecycle lock before the (bounded) re-embed
    // runs, so `lifecycleOperation` alone no longer covers the in-flight
    // window; the background reconciliation flag picks up where it left off.
    if (this.storage.isBackgroundReconciliationActive()) {
      return {
        status: 'degraded',
        state: 'reconciling',
        unsynced_vectors: unsyncedVectors,
        message: driftState.cause
          ? `Bounded background vector reconciliation is in progress: ${HealthService.describeDriftCause(driftState.cause)}.`
          : 'Bounded background vector reconciliation is in progress.',
        drift_cause: driftState.cause,
      };
    }

    if (unsyncedVectors > 0) {
      return {
        status: 'degraded',
        state: 'pending',
        unsynced_vectors: unsyncedVectors,
        message: driftState.cause
          ? `SQLite metadata is active, but vector reconciliation is still required: ${HealthService.describeDriftCause(driftState.cause)} — automatic retry was exhausted; run the repair tool (mode: "re-embed") or trigger reconciliation again.`
          : 'SQLite metadata is active, but vector reconciliation is still required.',
        drift_cause: driftState.cause,
      };
    }

    // strengthen-operational-observability task 3.2: the bidirectional
    // count cross-check — nothing on the SQLite side says reconciliation is
    // needed, but the vector store may still hold points SQLite has no
    // record of at all (an orphan from an interrupted delete, a stale
    // cross-device fallback point, ...). Cached (see `getCachedQdrantPointsTotal`)
    // since it is an N-collection scan, not a cheap local read.
    const qdrantCounts = await this.getCachedQdrantPointsTotal();
    if (qdrantCounts && qdrantCounts.total > memoryCount) {
      const surplus = qdrantCounts.total - memoryCount;
      if (surplus > HealthService.VECTOR_SURPLUS_TOLERANCE) {
        return {
          status: 'degraded',
          state: 'surplus_suspected',
          unsynced_vectors: 0,
          qdrant_points_total: qdrantCounts.total,
          sqlite_memory_count: memoryCount,
          checked_at: qdrantCounts.checkedAt,
          message: `The vector store reports ${qdrantCounts.total} managed points, ${surplus} more than SQLite's ` +
            `${memoryCount} authoritative memories — suspected orphan/vector-only points. ` +
            `Run the repair tool or a backup restore's drift detection to prune them.`,
        };
      }
    }

    return {
      status: 'healthy',
      state: 'reconciled',
      unsynced_vectors: 0,
      ...(qdrantCounts ? {
        qdrant_points_total: qdrantCounts.total,
        sqlite_memory_count: memoryCount,
        checked_at: qdrantCounts.checkedAt,
      } : {}),
    };
  }

  /**
   * strengthen-operational-observability task 3.2: cached — an N-collection
   * scan (`QdrantStore.getTotalManagedPointsCount`), not a cheap local
   * read — so a burst of health polls (or the authenticated `/health` route
   * being hit repeatedly) cannot each start a fresh full-registry Qdrant
   * scan. On a genuine failure, falls back to the last known total (still
   * tagged with its original `checked_at`, so a consumer can tell it is
   * stale) rather than dropping the signal outright — design.md risk
   * mitigation: "report staleness timestamp".
   */
  private async getCachedQdrantPointsTotal(): Promise<{ total: number; checkedAt: string } | null> {
    const now = Date.now();
    if (this.cachedQdrantPointsTotal && (now - this.cachedQdrantPointsTotal.at) < HealthService.VECTOR_COUNT_CACHE_MS) {
      return { total: this.cachedQdrantPointsTotal.total, checkedAt: new Date(this.cachedQdrantPointsTotal.at).toISOString() };
    }
    try {
      const total = await this.storage.qdrant.getTotalManagedPointsCount();
      this.cachedQdrantPointsTotal = { total, at: now };
      return { total, checkedAt: new Date(now).toISOString() };
    } catch (err) {
      this.logger?.warn({ event: 'vector_bidirectional_count_failed', err });
      return this.cachedQdrantPointsTotal
        ? { total: this.cachedQdrantPointsTotal.total, checkedAt: new Date(this.cachedQdrantPointsTotal.at).toISOString() }
        : null;
    }
  }

  private computeOverall(
    sqlite: ComponentHealth,
    qdrant: ComponentHealth,
    embedding: ComponentHealth,
    vectorReconciliation: VectorReconciliationStatus,
    retention: ComponentHealth,
    schedulers: ComponentHealth,
    bootstrapHydration: ComponentHealth,
    capacity: ComponentHealth,
  ): HealthStatus {
    if (sqlite.status === 'unhealthy') {
      return 'unhealthy';
    }
    if (
      qdrant.status === 'unhealthy' ||
      embedding.status === 'degraded' ||
      embedding.status === 'unhealthy' ||
      vectorReconciliation.status === 'degraded' ||
      vectorReconciliation.status === 'unhealthy' ||
      retention.status === 'degraded' ||
      retention.status === 'unhealthy' ||
      capacity.status === 'degraded' ||
      capacity.status === 'unhealthy' ||
      schedulers.status === 'degraded' ||
      schedulers.status === 'unhealthy' ||
      bootstrapHydration.status === 'degraded' ||
      bootstrapHydration.status === 'unhealthy' ||
      Object.values(this.breakers).some(breaker => breaker.getState() === 'open')
    ) {
      return 'degraded';
    }
    return 'healthy';
  }

  private isOverCapacity(counts: Record<RetentionTier, number>): boolean {
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const maxMemories = this.config?.retention?.max_memories ?? Number.MAX_SAFE_INTEGER;
    if (total > maxMemories) {
      return true;
    }

    for (const [tier, count] of Object.entries(counts) as Array<[RetentionTier, number]>) {
      const budget = this.config?.retention?.tier_budgets?.[tier] ?? null;
      if (budget !== null && count > budget) {
        return true;
      }
    }

    return false;
  }

  private getCircuitBreakerStates(): Record<string, 'closed' | 'open' | 'half-open'> {
    return Object.fromEntries(
      Object.entries(this.breakers).map(([name, breaker]) => [name, breaker.getState()]),
    );
  }
}
