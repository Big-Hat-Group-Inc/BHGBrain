import { v4 as uuidv4 } from 'uuid';
import { SqliteStore } from './sqlite.js';
import { QdrantStore } from './qdrant.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryRecord, WriteOperation, AuditEntry } from '../domain/types.js';
import { internal, conflict } from '../errors/index.js';

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
    mem: Omit<MemoryRecord, 'embedding'>,
    vector: number[],
  ): Promise<void> {
    this.ensureCollectionCompatible(mem.namespace, mem.collection);

    try {
      this.sqlite.insertMemory(mem);
    } catch (err) {
      throw internal(`SQLite write failed: ${(err as Error).message}`);
    }

    try {
      await this.qdrant.upsert(mem.namespace, mem.collection, mem.id, vector, {
        type: mem.type,
        tags: mem.tags,
        collection: mem.collection,
        content: mem.content,
        summary: mem.summary,
        category: mem.category,
        source: mem.source,
        importance: mem.importance,
        retention_tier: mem.retention_tier,
        decay_eligible: mem.decay_eligible,
        expires_at: mem.expires_at ? Math.floor(Date.parse(mem.expires_at) / 1000) : null,
        device_id: mem.device_id ?? null,
        created_at: mem.created_at,
      });
      if (typeof (this.sqlite as any).markVectorSync === 'function') {
        this.sqlite.markVectorSync(mem.id, true);
      }
    } catch (err) {
      if (typeof (this.sqlite as any).markVectorSync === 'function') {
        this.sqlite.markVectorSync(mem.id, false);
      }
      this.sqlite.flushIfDirty();
      throw internal(`Qdrant write failed after SQLite persistence: ${(err as Error).message}`);
    }

    this.sqlite.flushIfDirty();
  }

  writeMemoryWithoutVector(mem: Omit<MemoryRecord, 'embedding'>): void {
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
    const rollbackFields: Partial<Omit<MemoryRecord, 'embedding'>> = {};
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      (rollbackFields as any)[key] = (existing as any)[key];
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
          {
            type: fields.type ?? existing.type,
            tags: fields.tags ?? existing.tags,
            collection: existing.collection,
            content: fields.content ?? existing.content,
            summary: fields.summary ?? existing.summary,
            category: fields.category ?? existing.category,
            source: existing.source,
            importance: fields.importance ?? existing.importance,
            retention_tier: fields.retention_tier ?? existing.retention_tier,
            decay_eligible: fields.decay_eligible ?? existing.decay_eligible,
            expires_at: (fields.expires_at ?? existing.expires_at) ? Math.floor(Date.parse((fields.expires_at ?? existing.expires_at)! as string) / 1000) : null,
            device_id: fields.device_id ?? existing.device_id ?? null,
            created_at: existing.created_at,
          },
        );
        if (typeof (this.sqlite as any).markVectorSync === 'function') {
          this.sqlite.markVectorSync(id, true);
        }
      } catch (err) {
        this.sqlite.updateMemory(id, rollbackFields);
        if (typeof (this.sqlite as any).markVectorSync === 'function') {
          this.sqlite.markVectorSync(id, false);
        }
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
