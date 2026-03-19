import { QdrantClient } from '@qdrant/js-client-rest';
import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { CircuitOpenError } from '../resilience/index.js';
import { internal } from '../errors/index.js';

const COLLECTION_PREFIX = 'bhgbrain_';

export class QdrantStore {
  private client: QdrantClient;
  private dimensions: number;

  constructor(
    private config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
  ) {
    this.dimensions = config.embedding.dimensions;

    if (config.qdrant.mode === 'external' && config.qdrant.external_url) {
      const apiKey = config.qdrant.api_key_env
        ? process.env[config.qdrant.api_key_env]
        : undefined;
      this.client = new QdrantClient({
        url: config.qdrant.external_url,
        apiKey,
      });
    } else {
      this.client = new QdrantClient({
        url: 'http://localhost:6333',
      });
    }
  }

  private collectionName(namespace: string, collection: string): string {
    return `${COLLECTION_PREFIX}${namespace}_${collection}`;
  }

  async ensureCollection(namespace: string, collection: string): Promise<void> {
    const name = this.collectionName(namespace, collection);
    try {
      await this.client.getCollection(name);
    } catch {
      await this.client.createCollection(name, {
        vectors: {
          size: this.dimensions,
          distance: 'Cosine',
        },
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'namespace',
        field_schema: 'keyword',
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'type',
        field_schema: 'keyword',
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'retention_tier',
        field_schema: 'keyword',
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'decay_eligible',
        field_schema: 'bool',
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'expires_at',
        field_schema: 'integer',
      });
      await this.client.createPayloadIndex(name, {
        field_name: 'device_id',
        field_schema: 'keyword',
      });
    }
  }

  async upsert(
    namespace: string,
    collection: string,
    id: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.executeWithBreaker(async () => {
      const name = this.collectionName(namespace, collection);
      await this.ensureCollection(namespace, collection);
      await this.client.upsert(name, {
        wait: true,
        points: [{
          id,
          vector,
          payload: { ...payload, namespace },
        }],
      });
    });
  }

  async delete(namespace: string, collection: string, id: string): Promise<void> {
    await this.executeWithBreaker(async () => {
      const name = this.collectionName(namespace, collection);
      try {
        await this.client.delete(name, {
          wait: true,
          points: [id],
        });
      } catch (err) {
        if (this.isNotFoundError(err)) {
          return;
        }
        throw err;
      }
    });
  }

  async deleteMany(namespace: string, collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const name = this.collectionName(namespace, collection);
    try {
      await this.client.delete(name, {
        wait: true,
        points: ids,
      });
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return;
      }
      throw err;
    }
  }

  async search(
    namespace: string,
    collection: string | undefined,
    vector: number[],
    limit: number,
    filters?: {
      type?: string;
      tags?: string[];
      minScore?: number;
    },
  ): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    const collName = collection ?? 'general';
    const name = this.collectionName(namespace, collName);

    const must: Array<Record<string, unknown>> = [
      { key: 'namespace', match: { value: namespace } },
    ];
    if (filters?.type) {
      must.push({ key: 'type', match: { value: filters.type } });
    }
    must.push({
      should: [
        { key: 'decay_eligible', match: { value: false } },
        { key: 'expires_at', range: { gte: Math.floor(Date.now() / 1000) } },
        { is_empty: { key: 'expires_at' } },
      ],
    });

    const results = await this.executeWithBreaker(() => this.client.search(name, {
      vector,
      limit,
      filter: must.length > 0 ? { must } : undefined,
      score_threshold: filters?.minScore,
      with_payload: true,
    }));

    return results.map(r => ({
      id: r.id as string,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async searchSimilar(
    namespace: string,
    collection: string,
    vector: number[],
    topK: number,
  ): Promise<Array<{ id: string; score: number }>> {
    const name = this.collectionName(namespace, collection);
    try {
      const results = await this.client.search(name, {
        vector,
        limit: topK,
        filter: {
          must: [{ key: 'namespace', match: { value: namespace } }],
        },
        with_payload: false,
      });
      return results.map(r => ({ id: r.id as string, score: r.score }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  async getCollectionInfo(namespace: string, collection: string): Promise<{ points_count: number } | null> {
    const name = this.collectionName(namespace, collection);
    try {
      const info = await this.client.getCollection(name);
      return { points_count: info.points_count ?? 0 };
    } catch {
      return null;
    }
  }

  async deleteCollection(namespace: string, collection: string): Promise<void> {
    const name = this.collectionName(namespace, collection);
    try {
      await this.client.deleteCollection(name);
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return;
      }
      throw err;
    }
  }

  async createSnapshot(namespace: string, collection: string): Promise<string | null> {
    const name = this.collectionName(namespace, collection);
    try {
      const snapshot = await this.client.createSnapshot(name);
      return snapshot?.name ?? null;
    } catch {
      return null;
    }
  }

  async listAllCollections(): Promise<string[]> {
    const response = await this.client.getCollections();
    return response.collections
      .map(c => c.name)
      .filter(name => name.startsWith(COLLECTION_PREFIX));
  }

  async scrollAll(
    collectionName: string,
    batchSize = 100,
  ): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
    const allPoints: Array<{ id: string; payload: Record<string, unknown> }> = [];
    let offset: string | number | undefined = undefined;

    while (true) {
      const response = await this.client.scroll(collectionName, {
        limit: batchSize,
        offset,
        with_payload: true,
        with_vector: false,
      });

      for (const point of response.points) {
        allPoints.push({
          id: point.id as string,
          payload: (point.payload ?? {}) as Record<string, unknown>,
        });
      }

      if (!response.next_page_offset) break;
      offset = response.next_page_offset as string | number | undefined;
    }

    return allPoints;
  }

  private isNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const maybeErr = err as { status?: number; response?: { status?: number }; message?: string };
    const status = maybeErr.status ?? maybeErr.response?.status;
    if (status === 404) return true;
    const message = maybeErr.message?.toLowerCase() ?? '';
    return message.includes('not found') || message.includes('does not exist');
  }

  private async executeWithBreaker<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.breaker) {
      return fn();
    }

    try {
      return await this.breaker.execute(fn);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw internal('Qdrant circuit breaker is open');
      }
      throw error;
    }
  }
}
