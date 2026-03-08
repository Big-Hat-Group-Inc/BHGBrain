import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageManager } from './index.js';
import type { SqliteStore } from './sqlite.js';
import type { QdrantStore } from './qdrant.js';
import type { EmbeddingProvider } from '../embedding/index.js';

function createMockSqlite(): SqliteStore {
  const memoryStore = new Map<string, any>();

  return {
    getMemoryById: vi.fn((id: string) => memoryStore.get(id) ?? null),
    insertMemory: vi.fn((mem: any) => { memoryStore.set(mem.id, { ...mem }); }),
    updateMemory: vi.fn((id: string, fields: any) => {
      const existing = memoryStore.get(id);
      if (existing) {
        for (const [k, v] of Object.entries(fields)) {
          existing[k] = v;
        }
      }
    }),
    deleteMemory: vi.fn((id: string) => memoryStore.delete(id)),
    getCollection: vi.fn(() => ({ name: 'general', namespace: 'global', embedding_model: 'test', embedding_dimensions: 3 })),
    createCollection: vi.fn(),
    flushIfDirty: vi.fn(),
    countMemories: vi.fn(() => memoryStore.size),
  } as unknown as SqliteStore;
}

function createMockQdrant(shouldFail = false): QdrantStore {
  return {
    upsert: shouldFail
      ? vi.fn(async () => { throw new Error('Qdrant unavailable'); })
      : vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
  } as unknown as QdrantStore;
}

function createMockEmbedding(): EmbeddingProvider {
  return {
    model: 'test',
    dimensions: 3,
    embed: vi.fn(async () => [1, 2, 3]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3])),
    healthCheck: vi.fn(async () => true),
  };
}

describe('StorageManager cross-store consistency', () => {
  const baseMem = {
    id: 'mem-1',
    namespace: 'global',
    collection: 'general',
    type: 'semantic' as const,
    category: null,
    content: 'test content',
    summary: 'test',
    tags: ['a'],
    source: 'cli' as const,
    checksum: 'chk1',
    importance: 0.5,
    access_count: 0,
    last_operation: 'ADD' as const,
    merged_from: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_accessed: new Date().toISOString(),
  };

  describe('writeMemory rollback', () => {
    it('rolls back SQLite insert when Qdrant upsert fails', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(true);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await expect(storage.writeMemory(baseMem, [1, 2, 3])).rejects.toThrow('Qdrant write failed');
      expect(sqlite.deleteMemory).toHaveBeenCalledWith('mem-1');
    });
  });

  describe('updateMemory rollback', () => {
    it('rolls back SQLite update when Qdrant upsert fails', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      // First write succeeds
      await storage.writeMemory(baseMem, [1, 2, 3]);

      // Now make Qdrant fail for update
      (qdrant.upsert as any).mockRejectedValueOnce(new Error('Qdrant unavailable'));

      await expect(
        storage.updateMemory('mem-1', { importance: 0.9, tags: ['b'] }, [4, 5, 6]),
      ).rejects.toThrow('Qdrant update failed, rolled back SQLite');

      // SQLite updateMemory should have been called twice: once for update, once for rollback
      expect(sqlite.updateMemory).toHaveBeenCalledTimes(2);
      // Second call should restore original values
      const rollbackCall = (sqlite.updateMemory as any).mock.calls[1];
      expect(rollbackCall[1]).toEqual({ importance: 0.5, tags: ['a'] });
    });
  });

  describe('updateMemory without vector', () => {
    it('does not touch Qdrant when no new vector is provided', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory(baseMem, [1, 2, 3]);
      // Reset the upsert mock count
      (qdrant.upsert as any).mockClear();

      await storage.updateMemory('mem-1', { importance: 0.8 });
      expect(qdrant.upsert).not.toHaveBeenCalled();
    });
  });
});
