import { v4 as uuidv4 } from 'uuid';
import { SqliteStore } from './sqlite.js';
import { QdrantStore } from './qdrant.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryRecord, WriteOperation, AuditEntry } from '../domain/types.js';
import { internal, conflict } from '../errors/index.js';

type MemoryRecordWithoutEmbedding = Omit<MemoryRecord, 'embedding'>;

export class StorageManager {
  constructor(
    public readonly sqlite: SqliteStore,
    public readonly qdrant: QdrantStore,
    public readonly embedding: EmbeddingProvider,
  ) {}

  async init(): Promise<void> {
    await this.sqlite.init();
  }

  async writeMemory(
    mem: MemoryRecordWithoutEmbedding,
    vector: number[],
  ): Promise<void> {
    this.ensureCollectionCompatible(mem.namespace, mem.collection);

    try {
      this.sqlite.insertMemory(mem);
    } catch (err) {
      throw internal(`SQLite write failed: ${(err as Error).message}`);
    }

    try {
      await this.qdrant.upsert(mem.namespace, mem.collection, mem.id, vector, toQdrantPayload(mem));
      this.sqlite.markVectorSync(mem.id, true);
    } catch (err) {
      this.sqlite.markVectorSync(mem.id, false);
      this.sqlite.flushIfDirty();
      throw internal(`Qdrant write failed after SQLite persistence: ${(err as Error).message}`);
    }

    this.sqlite.flushIfDirty();
  }

  writeMemoryWithoutVector(mem: MemoryRecordWithoutEmbedding): void {
    this.ensureCollectionCompatible(mem.namespace, mem.collection);
    try {
      this.sqlite.insertMemory({
        ...mem,
        vector_synced: false,
      });
      this.sqlite.flushIfDirty();
    } catch (err) {
      throw internal(`SQLite degraded write failed: ${(err as Error).message}`);
    }
  }

  async updateMemory(
    id: string,
    fields: Partial<Omit<MemoryRecord, 'embedding'>>,
    newVector?: number[],
  ): Promise<void> {
    const existing = this.sqlite.getMemoryById(id);
    if (!existing) throw internal(`Memory ${id} not found for update`);

    // Snapshot fields that will change for rollback
    const rollbackFields: Partial<MemoryRecordWithoutEmbedding> = {};
    for (const key of Object.keys(fields) as Array<keyof MemoryRecordWithoutEmbedding>) {
      const currentValue = existing[key];
      assignRollbackField(rollbackFields, key, currentValue);
    }

    if (existing.retention_tier === 'T0' && fields.content && fields.content !== existing.content) {
      this.sqlite.insertRevision(id, this.sqlite.listRevisions(id).length + 1, existing.content, new Date().toISOString());
    }

    this.sqlite.updateMemory(id, fields);

    if (newVector) {
      try {
        await this.qdrant.upsert(
          existing.namespace,
          existing.collection,
          id,
          newVector,
          toQdrantPayload({
            ...existing,
            ...fields,
            collection: existing.collection,
          }),
        );
        this.sqlite.markVectorSync(id, true);
      } catch (err) {
        this.sqlite.updateMemory(id, rollbackFields);
        this.sqlite.markVectorSync(id, false);
        this.sqlite.flushIfDirty();
        throw internal(`Qdrant update failed, rolled back SQLite: ${(err as Error).message}`);
      }
    }

    this.sqlite.flushIfDirty();
  }

  async deleteMemory(id: string, options?: { flush?: boolean }): Promise<boolean> {
    const mem = this.sqlite.getMemoryById(id);
    if (!mem) return false;
    try {
      await this.qdrant.delete(mem.namespace, mem.collection, id);
    } catch (err) {
      throw internal(`Qdrant delete failed: ${(err as Error).message}`);
    }
    const deleted = this.sqlite.deleteMemory(id);
    if (options?.flush !== false) {
      this.sqlite.flushIfDirty();
    }
    return deleted;
  }

  async deleteMemories(
    memories: Array<Pick<MemoryRecord, 'id' | 'namespace' | 'collection'>>,
    options?: { flush?: boolean },
  ): Promise<number> {
    if (memories.length === 0) return 0;

    const grouped = new Map<string, string[]>();
    for (const memory of memories) {
      const key = `${memory.namespace}|${memory.collection}`;
      const ids = grouped.get(key) ?? [];
      ids.push(memory.id);
      grouped.set(key, ids);
    }

    for (const [key, ids] of grouped.entries()) {
      const [namespace, collection] = key.split('|');
      await this.qdrant.deleteMany(namespace!, collection!, ids);
    }

    let deleted = 0;
    for (const memory of memories) {
      if (this.sqlite.deleteMemory(memory.id)) {
        deleted++;
      }
    }

    if (options?.flush !== false) {
      this.sqlite.flushIfDirty();
    }
    return deleted;
  }

  countMemoriesInCollection(namespace: string, collection: string): number {
    return this.sqlite.countMemoriesInCollection(namespace, collection);
  }

  async deleteCollectionData(namespace: string, collection: string): Promise<{ deleted: number; ids: string[] }> {
    const ids = this.sqlite.listMemoryIdsInCollection(namespace, collection);
    await this.qdrant.deleteCollection(namespace, collection);
    const removed = this.sqlite.deleteMemoriesInCollection(namespace, collection);
    if (removed.deleted > 0) {
      this.sqlite.flushIfDirty();
    }
    return ids.length > 0 ? { deleted: removed.deleted, ids } : removed;
  }

  async reloadSqliteFromDisk(): Promise<void> {
    await this.sqlite.reloadFromDisk();
  }

  markAllMemoriesVectorSync(synced: boolean, options?: { allowDuringLifecycle?: boolean }): number {
    const affected = this.sqlite.markAllVectorsSyncState(synced, options);
    this.sqlite.flushIfDirty();
    return affected;
  }

  async clearManagedVectors(): Promise<number> {
    return this.qdrant.clearManagedCollections();
  }

  async reconcileVectorsFromSqlite(
    options?: { batchSize?: number; allowDuringLifecycle?: boolean },
  ): Promise<{ reconciled: number; remaining: number }> {
    const batchSize = options?.batchSize ?? 100;
    let cursor: string | undefined;
    let reconciled = 0;

    while (true) {
      const memories = this.sqlite.listMemoriesNeedingVectorSync(batchSize, cursor);
      if (memories.length === 0) {
        break;
      }

      for (const memory of memories) {
        this.ensureCollectionCompatible(memory.namespace, memory.collection);
      }

      const vectors = await this.embedding.embedBatch(memories.map(memory => memory.content));

      for (const [index, memory] of memories.entries()) {
        const vector = vectors[index];
        if (!vector) {
          this.sqlite.flushIfDirty();
          throw internal(`Missing embedding vector for memory ${memory.id}`);
        }

        try {
          await this.qdrant.upsert(
            memory.namespace,
            memory.collection,
            memory.id,
            vector,
            toQdrantPayload(memory),
          );
          this.sqlite.markVectorSync(memory.id, true, {
            allowDuringLifecycle: options?.allowDuringLifecycle,
          });
          reconciled++;
        } catch (err) {
          this.sqlite.flushIfDirty();
          throw err;
        }
      }

      this.sqlite.flushIfDirty();

      if (memories.length < batchSize) {
        break;
      }
      const last = memories[memories.length - 1]!;
      cursor = `${last.created_at}|${last.id}`;
    }

    return { reconciled, remaining: this.sqlite.countUnsyncedVectors() };
  }

  logAudit(
    operation: WriteOperation | 'FORGET',
    memoryId: string,
    namespace: string,
    clientId = 'unknown',
    options?: { flush?: boolean },
  ): void {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      namespace,
      operation,
      memory_id: memoryId,
      client_id: clientId,
    };
    this.sqlite.insertAudit(entry);
    if (options?.flush !== false) {
      this.sqlite.flushIfDirty();
    }
  }

  private ensureCollectionCompatible(namespace: string, collection: string): void {
    const col = this.sqlite.getCollection(namespace, collection);
    if (col) {
      if (col.embedding_model !== this.embedding.model || col.embedding_dimensions !== this.embedding.dimensions) {
        throw conflict(
          `Collection "${collection}" uses ${col.embedding_model} (${col.embedding_dimensions}d), ` +
          `but current provider is ${this.embedding.model} (${this.embedding.dimensions}d). ` +
          `Cannot mix embedding spaces.`,
        );
      }
      return;
    }

    this.sqlite.createCollection(
      namespace, collection,
      this.embedding.model, this.embedding.dimensions,
    );
  }
}

export { SqliteStore } from './sqlite.js';
export { QdrantStore } from './qdrant.js';

function assignRollbackField<K extends keyof MemoryRecordWithoutEmbedding>(
  target: Partial<MemoryRecordWithoutEmbedding>,
  key: K,
  value: MemoryRecordWithoutEmbedding[K],
): void {
  target[key] = value;
}

function toQdrantPayload(
  mem: Pick<
    MemoryRecordWithoutEmbedding,
    'type' | 'tags' | 'collection' | 'content' | 'summary' | 'category' | 'source' |
    'importance' | 'retention_tier' | 'decay_eligible' | 'expires_at' | 'created_at'
  > & { device_id?: string | null },
): Record<string, unknown> {
  return {
    type: mem.type,
    tags: mem.tags,
    collection: mem.collection,
    content: mem.content,
    summary: mem.summary,
    category: mem.category ?? null,
    source: mem.source,
    importance: mem.importance,
    retention_tier: mem.retention_tier,
    decay_eligible: mem.decay_eligible,
    expires_at: mem.expires_at ? Math.floor(Date.parse(mem.expires_at) / 1000) : null,
    device_id: mem.device_id ?? null,
    created_at: mem.created_at,
  };
}
