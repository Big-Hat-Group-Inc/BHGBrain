import { QdrantClient } from '@qdrant/js-client-rest';
import type { BrainConfig } from '../config/index.js';

const COLLECTION_PREFIX = 'bhgbrain_';

export class QdrantStore {
  private client: QdrantClient;
  private dimensions: number;

  constructor(private config: BrainConfig) {
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
    }
  }

  async upsert(
    namespace: string,
    collection: string,
    id: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
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
  }

  async delete(namespace: string, collection: string, id: string): Promise<void> {
    const name = this.collectionName(namespace, collection);
    try {
      await this.client.delete(name, {
        wait: true,
        points: [id],
      });
    } catch {
      // Collection may not exist; ignore
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

    const must: any[] = [
      { key: 'namespace', match: { value: namespace } },
    ];
    if (filters?.type) {
      must.push({ key: 'type', match: { value: filters.type } });
    }

    const results = await this.client.search(name, {
      vector,
      limit,
      filter: must.length > 0 ? { must } : undefined,
      score_threshold: filters?.minScore,
      with_payload: true,
    });

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
    } catch {
      // Ignore if doesn't exist
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
}
