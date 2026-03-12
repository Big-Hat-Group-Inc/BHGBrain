import { v4 as uuidv4 } from 'uuid';
import { SqliteStore } from './sqlite.js';
import { QdrantStore } from './qdrant.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryRecord, WriteOperation, AuditEntry, CategoryRecord, CollectionInfo } from '../domain/types.js';
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
    // Check embedding space compatibility
    const col = this.sqlite.getCollection(mem.namespace, mem.collection);
    if (col) {
      if (col.embedding_model !== this.embedding.model || col.embedding_dimensions !== this.embedding.dimensions) {
        throw conflict(
          `Collection "${mem.collection}" uses ${col.embedding_model} (${col.embedding_dimensions}d), ` +
          `but current provider is ${this.embedding.model} (${this.embedding.dimensions}d). ` +
          `Cannot mix embedding spaces.`,
        );
      }
    } else {
      this.sqlite.createCollection(
        mem.namespace, mem.collection,
        this.embedding.model, this.embedding.dimensions,
      );
    }

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
        importance: mem.importance,
        retention_tier: mem.retention_tier,
        decay_eligible: mem.decay_eligible,
        expires_at: mem.expires_at ? Math.floor(Date.parse(mem.expires_at) / 1000) : null,
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
            importance: fields.importance ?? existing.importance,
            retention_tier: fields.retention_tier ?? existing.retention_tier,
            decay_eligible: fields.decay_eligible ?? existing.decay_eligible,
            expires_at: (fields.expires_at ?? existing.expires_at) ? Math.floor(Date.parse((fields.expires_at ?? existing.expires_at)! as string) / 1000) : null,
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

  async deleteMemory(id: string): Promise<boolean> {
    const mem = this.sqlite.getMemoryById(id);
    if (!mem) return false;
    try {
      await this.qdrant.delete(mem.namespace, mem.collection, id);
    } catch (err) {
      throw internal(`Qdrant delete failed: ${(err as Error).message}`);
    }
    const deleted = this.sqlite.deleteMemory(id);
    this.sqlite.flushIfDirty();
    return deleted;
  }

  countMemoriesInCollection(namespace: string, collection: string): number {
    return this.sqlite.countMemoriesInCollection(namespace, collection);
  }

  async deleteCollectionData(namespace: string, collection: string): Promise<{ deleted: number; ids: string[] }> {
    const removed = this.sqlite.deleteMemoriesInCollection(namespace, collection);
    if (removed.deleted > 0) {
      this.sqlite.flushIfDirty();
    }

    await this.qdrant.deleteCollection(namespace, collection);
    return removed;
  }

  async reloadSqliteFromDisk(): Promise<void> {
    await this.sqlite.reloadFromDisk();
  }

  logAudit(operation: WriteOperation | 'FORGET', memoryId: string, namespace: string, clientId = 'unknown'): void {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      namespace,
      operation,
      memory_id: memoryId,
      client_id: clientId,
    };
    this.sqlite.insertAudit(entry);
    this.sqlite.flushIfDirty();
  }
}

export { SqliteStore } from './sqlite.js';
export { QdrantStore } from './qdrant.js';
