import type { HealthSnapshot, HealthStatus, ComponentHealth } from '../domain/types.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider, DegradedEmbeddingProvider } from '../embedding/index.js';

const startTime = Date.now();

export class HealthService {
  private cachedEmbeddingHealth: ComponentHealth | null = null;
  private cachedEmbeddingAt = 0;
  private static readonly EMBEDDING_CACHE_MS = 30_000; // cache for 30s

  constructor(
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
  ) {}

  async check(): Promise<HealthSnapshot> {
    const [sqliteOk, qdrantOk, embeddingOk] = await Promise.all([
      this.checkSqlite(),
      this.checkQdrant(),
      this.checkEmbedding(),
    ]);

    const overall = this.computeOverall(sqliteOk, qdrantOk, embeddingOk);

    return {
      status: overall,
      components: {
        sqlite: sqliteOk,
        qdrant: qdrantOk,
        embedding: embeddingOk,
      },
      memory_count: this.storage.sqlite.countMemories(),
      db_size_bytes: this.storage.sqlite.getDbSizeBytes(),
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
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

  private computeOverall(
    sqlite: ComponentHealth,
    qdrant: ComponentHealth,
    embedding: ComponentHealth,
  ): HealthStatus {
    if (sqlite.status === 'unhealthy' || qdrant.status === 'unhealthy') {
      return 'unhealthy';
    }
    if (embedding.status === 'degraded' || embedding.status === 'unhealthy') {
      return 'degraded';
    }
    return 'healthy';
  }
}
