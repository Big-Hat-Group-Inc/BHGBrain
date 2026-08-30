import type pino from 'pino';
import type { BrainConfig } from '../config/index.js';
import type { HealthSnapshot, HealthStatus, ComponentHealth, VectorReconciliationStatus } from '../domain/types.js';
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

  constructor(
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
    private config: BrainConfig,
    private breakers: Record<string, CircuitBreaker> = {},
    private logger?: pino.Logger,
  ) {}

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
    const vectorReconciliation = this.checkVectorReconciliation(stats.unsyncedVectors);

    const overall = this.computeOverall(sqliteOk, qdrantOk, embeddingOk, vectorReconciliation, retentionOk);

    return {
      status: overall,
      components: {
        sqlite: sqliteOk,
        qdrant: qdrantOk,
        embedding: embeddingOk,
        vector_reconciliation: vectorReconciliation,
        retention: retentionOk,
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
    try {
      const ok = await this.storage.qdrant.healthCheck();
      return ok
        ? { status: 'healthy' }
        : { status: 'unhealthy', message: 'Qdrant unreachable' };
    } catch (err) {
      const message = (err as Error).message;
      // Log the raw failure reason so an operator reading structured logs can
      // tell a retrieval-path failure (e.g. "this.client.query is not a
      // function") from a plain connectivity failure (e.g. ECONNREFUSED),
      // not just an operator polling /health and reading the message field.
      this.logger?.warn({ event: 'qdrant_health_check_failed', message });
      return { status: 'unhealthy', message };
    }
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

  private checkVectorReconciliation(unsyncedVectors: number): VectorReconciliationStatus {
    // `getLifecycleOperation()`/`isBackgroundReconciliationActive()` are live
    // in-memory/single-row reads, so the "reconciling" transition is visible
    // immediately regardless of the stats cache above — only `unsyncedVectors`
    // itself (the "pending" vs. "healthy" count) is sourced from the shared
    // snapshot.
    const lifecycleOperation = this.storage.sqlite.getLifecycleOperation();

    if (lifecycleOperation === 'restore') {
      return {
        status: 'degraded',
        state: 'reconciling',
        unsynced_vectors: unsyncedVectors,
        message: 'Restore is active and vector reconciliation is in progress.',
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
        message: 'Bounded background vector reconciliation is in progress.',
      };
    }

    if (unsyncedVectors > 0) {
      return {
        status: 'degraded',
        state: 'pending',
        unsynced_vectors: unsyncedVectors,
        message: 'SQLite metadata is active, but vector reconciliation is still required.',
      };
    }

    return {
      status: 'healthy',
      state: 'reconciled',
      unsynced_vectors: 0,
    };
  }

  private computeOverall(
    sqlite: ComponentHealth,
    qdrant: ComponentHealth,
    embedding: ComponentHealth,
    vectorReconciliation: VectorReconciliationStatus,
    retention: ComponentHealth,
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
