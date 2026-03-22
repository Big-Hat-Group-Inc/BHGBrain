import type { BrainConfig } from '../config/index.js';
import type { HealthSnapshot, HealthStatus, ComponentHealth, VectorReconciliationStatus } from '../domain/types.js';
import type { StorageManager } from '../storage/index.js';
import { DegradedEmbeddingProvider, type EmbeddingProvider } from '../embedding/index.js';
import type { RetentionTier } from '../domain/types.js';
import type { CircuitBreaker } from '../resilience/index.js';

const startTime = Date.now();

export class HealthService {
  private cachedEmbeddingHealth: ComponentHealth | null = null;
  private cachedEmbeddingAt = 0;
  private static readonly EMBEDDING_CACHE_MS = 30_000; // cache for 30s

  constructor(
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
    private config: BrainConfig,
    private breakers: Record<string, CircuitBreaker> = {},
  ) {}

  async check(): Promise<HealthSnapshot> {
    const [sqliteOk, qdrantOk, embeddingOk] = await Promise.all([
      this.checkSqlite(),
      this.checkQdrant(),
      this.checkEmbedding(),
    ]);
    const retentionOk = this.checkRetention();
    const vectorReconciliation = this.checkVectorReconciliation();

    const overall = this.computeOverall(sqliteOk, qdrantOk, embeddingOk, vectorReconciliation, retentionOk);
    const countsByTier = this.storage.sqlite.countByTier();
    const now = new Date();
    const until = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));

    return {
      status: overall,
      components: {
        sqlite: sqliteOk,
        qdrant: qdrantOk,
        embedding: embeddingOk,
        vector_reconciliation: vectorReconciliation,
        retention: retentionOk,
      },
      memory_count: this.storage.sqlite.countMemories(),
      db_size_bytes: this.storage.sqlite.getDbSizeBytes(),
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      circuitBreakers: this.getCircuitBreakerStates(),
      retention: {
        counts_by_tier: countsByTier,
        expiring_soon: this.storage.sqlite.countExpiringMemories(now.toISOString(), until.toISOString()),
        archived_count: this.storage.sqlite.countArchivedMemories(),
        unsynced_vectors: this.storage.sqlite.countUnsyncedVectors(),
        over_capacity: this.isOverCapacity(countsByTier),
      },
    };
  }

  private checkSqlite(): ComponentHealth {
    try {
      const ok = this.storage.sqlite.healthCheck();
      return ok
        ? { status: 'healthy' }
        : { status: 'unhealthy', message: 'SQLite health check failed' };
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
      return { status: 'unhealthy', message: (err as Error).message };
    }
  }

  private async checkEmbedding(): Promise<ComponentHealth> {
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

  private checkRetention(): ComponentHealth {
    const counts = this.storage.sqlite.countByTier();
    if (this.isOverCapacity(counts)) {
      return { status: 'degraded', message: 'Retention tier or total capacity threshold exceeded' };
    }
    return { status: 'healthy' };
  }

  private checkVectorReconciliation(): VectorReconciliationStatus {
    const unsyncedVectors = this.storage.sqlite.countUnsyncedVectors();
    const lifecycleOperation = this.storage.sqlite.getLifecycleOperation();

    if (lifecycleOperation === 'restore') {
      return {
        status: 'degraded',
        state: 'reconciling',
        unsynced_vectors: unsyncedVectors,
        message: 'Restore is active and vector reconciliation is in progress.',
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
