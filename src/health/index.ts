import type { BrainConfig } from '../config/index.js';
import type { HealthSnapshot, HealthStatus, ComponentHealth } from '../domain/types.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider, DegradedEmbeddingProvider } from '../embedding/index.js';
import type { RetentionTier } from '../domain/types.js';

const startTime = Date.now();

export class HealthService {
  private cachedEmbeddingHealth: ComponentHealth | null = null;
  private cachedEmbeddingAt = 0;
  private static readonly EMBEDDING_CACHE_MS = 30_000; // cache for 30s

  constructor(
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
    private config: BrainConfig,
  ) {}

  async check(): Promise<HealthSnapshot> {
    const [sqliteOk, qdrantOk, embeddingOk] = await Promise.all([
      this.checkSqlite(),
      this.checkQdrant(),
      this.checkEmbedding(),
    ]);
    const retentionOk = this.checkRetention();

    const overall = this.computeOverall(sqliteOk, qdrantOk, embeddingOk, retentionOk);
    const countsByTier = typeof (this.storage.sqlite as any).countByTier === 'function'
      ? this.storage.sqlite.countByTier()
      : { T0: 0, T1: 0, T2: 0, T3: 0 };
    const now = new Date();
    const until = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));

    return {
      status: overall,
      components: {
        sqlite: sqliteOk,
        qdrant: qdrantOk,
        embedding: embeddingOk,
        retention: retentionOk,
      },
      memory_count: this.storage.sqlite.countMemories(),
      db_size_bytes: this.storage.sqlite.getDbSizeBytes(),
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      retention: {
        counts_by_tier: countsByTier,
        expiring_soon: typeof (this.storage.sqlite as any).countExpiringMemories === 'function'
          ? this.storage.sqlite.countExpiringMemories(now.toISOString(), until.toISOString())
          : 0,
        archived_count: typeof (this.storage.sqlite as any).countArchivedMemories === 'function'
          ? this.storage.sqlite.countArchivedMemories()
          : 0,
        unsynced_vectors: typeof (this.storage.sqlite as any).countUnsyncedVectors === 'function'
          ? this.storage.sqlite.countUnsyncedVectors()
          : 0,
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
    if ('degraded' in this.embedding && (this.embedding as DegradedEmbeddingProvider).degraded) {
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
    if (typeof (this.storage.sqlite as any).countByTier !== 'function') {
      return { status: 'healthy' };
    }
    const counts = this.storage.sqlite.countByTier();
    if (this.isOverCapacity(counts)) {
      return { status: 'degraded', message: 'Retention tier or total capacity threshold exceeded' };
    }
    if (typeof (this.storage.sqlite as any).countUnsyncedVectors === 'function' && this.storage.sqlite.countUnsyncedVectors() > 0) {
      return { status: 'degraded', message: 'SQLite and Qdrant lifecycle state are out of sync' };
    }
    return { status: 'healthy' };
  }

  private computeOverall(
    sqlite: ComponentHealth,
    qdrant: ComponentHealth,
    embedding: ComponentHealth,
    retention: ComponentHealth,
  ): HealthStatus {
    if (sqlite.status === 'unhealthy' || qdrant.status === 'unhealthy') {
      return 'unhealthy';
    }
    if (
      embedding.status === 'degraded' ||
      embedding.status === 'unhealthy' ||
      retention.status === 'degraded' ||
      retention.status === 'unhealthy'
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
}
