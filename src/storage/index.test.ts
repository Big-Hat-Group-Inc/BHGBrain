import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageManager } from './index.js';
import type { SqliteStore } from './sqlite.js';
import type { QdrantStore } from './qdrant.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryRecord } from '../domain/types.js';

type StoredMemory = Omit<MemoryRecord, 'embedding'>;
type MockSqliteStore = SqliteStore & {
  insertMemory: ReturnType<typeof vi.fn>;
  updateMemory: ReturnType<typeof vi.fn>;
  getCollection: ReturnType<typeof vi.fn>;
  listMemoriesNeedingVectorSync: ReturnType<typeof vi.fn>;
};
type MockQdrantStore = QdrantStore & {
  upsert: ReturnType<typeof vi.fn>;
  clearManagedCollections: ReturnType<typeof vi.fn>;
};

function createMockSqlite(): MockSqliteStore {
  const memoryStore = new Map<string, StoredMemory>();

  return {
    getMemoryById: vi.fn((id: string) => memoryStore.get(id) ?? null),
    insertMemory: vi.fn((mem: StoredMemory) => { memoryStore.set(mem.id, { ...mem }); }),
    updateMemory: vi.fn((id: string, fields: Partial<StoredMemory>) => {
      const existing = memoryStore.get(id);
      if (existing) {
        for (const [k, v] of Object.entries(fields)) {
          const key = k as keyof StoredMemory;
          existing[key] = v as StoredMemory[typeof key];
        }
      }
    }),
    deleteMemory: vi.fn((id: string) => memoryStore.delete(id)),
    markVectorSync: vi.fn((id: string, synced: boolean) => {
      const existing = memoryStore.get(id);
      if (existing) {
        existing.vector_synced = synced;
      }
    }),
    listRevisions: vi.fn(() => []),
    insertRevision: vi.fn(),
    getCollection: vi.fn(() => ({ name: 'general', namespace: 'global', embedding_model: 'test', embedding_dimensions: 3 })),
    createCollection: vi.fn(),
    listMemoryIdsInCollection: vi.fn(() => ['mem-1']),
    listMemoriesNeedingVectorSync: vi.fn(() => []),
    flushIfDirty: vi.fn(),
    countMemories: vi.fn(() => memoryStore.size),
    countUnsyncedVectors: vi.fn(() => Array.from(memoryStore.values()).filter(mem => !mem.vector_synced).length),
    markAllVectorsSyncState: vi.fn((synced: boolean) => {
      for (const memory of memoryStore.values()) {
        memory.vector_synced = synced;
      }
      return memoryStore.size;
    }),
  } as unknown as MockSqliteStore;
}

function createMockQdrant(shouldFail = false): MockQdrantStore {
  return {
    upsert: shouldFail
      ? vi.fn(async () => { throw new Error('Qdrant unavailable'); })
      : vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    deleteMany: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
    clearManagedCollections: vi.fn(async () => 0),
  } as unknown as MockQdrantStore;
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
    retention_tier: 'T2' as const,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    decay_eligible: true,
    review_due: null,
    access_count: 0,
    last_operation: 'ADD' as const,
    merged_from: null,
    archived: false,
    vector_synced: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_accessed: new Date().toISOString(),
  };

  describe('writeMemory recovery', () => {
    it('keeps SQLite state and marks vector drift when Qdrant upsert fails', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(true);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await expect(storage.writeMemory(baseMem, [1, 2, 3])).rejects.toThrow('Qdrant write failed');
      expect(sqlite.deleteMemory).not.toHaveBeenCalled();
      expect(sqlite.markVectorSync).toHaveBeenCalledWith('mem-1', false);
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
      qdrant.upsert.mockRejectedValueOnce(new Error('Qdrant unavailable'));

      await expect(
        storage.updateMemory('mem-1', { importance: 0.9, tags: ['b'] }, [4, 5, 6]),
      ).rejects.toThrow('Qdrant update failed, rolled back SQLite');

      // SQLite updateMemory should have been called twice: once for update, once for rollback
      expect(sqlite.updateMemory).toHaveBeenCalledTimes(2);
      // Second call should restore original values
      const rollbackCall = sqlite.updateMemory.mock.calls[1];
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
      qdrant.upsert.mockClear();

      await storage.updateMemory('mem-1', { importance: 0.8 });
      expect(qdrant.upsert).not.toHaveBeenCalled();
    });
  });

  describe('degraded writes', () => {
    it('preserves collection metadata and marks vector sync false', () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.getCollection = vi.fn(() => null);
      storage.writeMemoryWithoutVector(baseMem);

      expect(sqlite.createCollection).toHaveBeenCalledWith('global', 'general', 'test', 3);
      expect(sqlite.insertMemory).toHaveBeenCalledWith(expect.objectContaining({ vector_synced: false }));
    });
  });

  describe('restore reconciliation helpers', () => {
    it('rebuilds unsynced vectors from restored SQLite rows', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', vector_synced: false });
      sqlite.insertMemory({ ...baseMem, id: 'mem-b', vector_synced: false, content: 'content-b', checksum: 'chk2' });
      sqlite.listMemoriesNeedingVectorSync
        .mockReturnValueOnce([
          sqlite.getMemoryById('mem-a')!,
          sqlite.getMemoryById('mem-b')!,
        ])
        .mockReturnValueOnce([]);

      const result = await storage.reconcileVectorsFromSqlite({ batchSize: 2 });

      expect(embedding.embedBatch).toHaveBeenCalledWith(['test content', 'content-b']);
      expect(qdrant.upsert).toHaveBeenCalledTimes(2);
      expect(sqlite.markVectorSync).toHaveBeenNthCalledWith(1, 'mem-a', true, {
        allowDuringLifecycle: undefined,
      });
      expect(sqlite.markVectorSync).toHaveBeenNthCalledWith(2, 'mem-b', true, {
        allowDuringLifecycle: undefined,
      });
      expect(result).toEqual({ reconciled: 2, remaining: 0 });
    });

    it('flushes completed reconciliation progress before returning a later failure', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', vector_synced: false });
      sqlite.insertMemory({ ...baseMem, id: 'mem-b', vector_synced: false, content: 'content-b', checksum: 'chk2' });
      sqlite.listMemoriesNeedingVectorSync
        .mockReturnValueOnce([
          sqlite.getMemoryById('mem-a')!,
          sqlite.getMemoryById('mem-b')!,
        ])
        .mockReturnValueOnce([
          sqlite.getMemoryById('mem-b')!,
        ])
        .mockReturnValueOnce([]);

      qdrant.upsert
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Qdrant unavailable'))
        .mockResolvedValueOnce(undefined);

      await expect(storage.reconcileVectorsFromSqlite({ batchSize: 2 })).rejects.toThrow('Qdrant unavailable');
      expect(sqlite.flushIfDirty).toHaveBeenCalledTimes(1);
      expect(sqlite.getMemoryById('mem-a')?.vector_synced).toBe(true);
      expect(sqlite.getMemoryById('mem-b')?.vector_synced).toBe(false);
      expect(sqlite.countUnsyncedVectors()).toBe(1);

      const retryResult = await storage.reconcileVectorsFromSqlite({ batchSize: 2 });

      expect(retryResult).toEqual({ reconciled: 1, remaining: 0 });
      expect(sqlite.getMemoryById('mem-b')?.vector_synced).toBe(true);
    });
  });

  describe('bootstrapFromQdrant', () => {
    it('hydrates SQLite from Qdrant collections and returns total count', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => [
        'bhgbrain_global_general',
        'bhgbrain_global_notes',
      ]);
      (qdrant as unknown as Record<string, unknown>).scrollAll = vi.fn(async (name: string) => {
        if (name === 'bhgbrain_global_general') {
          return [
            { id: 'p1', payload: { content: 'c1', summary: 's1' } },
            { id: 'p2', payload: { content: 'c2', summary: 's2' } },
          ];
        }
        return [{ id: 'p3', payload: { content: 'c3', summary: 's3' } }];
      });
      (sqlite as unknown as Record<string, unknown>).upsertMemoryFromPayload = vi.fn(() => true);

      const total = await storage.bootstrapFromQdrant();

      expect(total).toBe(3);
      expect((sqlite as unknown as { upsertMemoryFromPayload: ReturnType<typeof vi.fn> }).upsertMemoryFromPayload).toHaveBeenCalledTimes(3);
      expect(sqlite.flushIfDirty).toHaveBeenCalled();
    });

    it('returns 0 when Qdrant has no collections', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => []);

      const total = await storage.bootstrapFromQdrant();
      expect(total).toBe(0);
    });

    it('skips existing rows via upsert idempotency', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => ['bhgbrain_global_general']);
      (qdrant as unknown as Record<string, unknown>).scrollAll = vi.fn(async () => [
        { id: 'existing', payload: { content: 'c1' } },
        { id: 'new', payload: { content: 'c2' } },
      ]);
      // First call returns false (already exists), second returns true (inserted)
      const upsertMock = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
      (sqlite as unknown as Record<string, unknown>).upsertMemoryFromPayload = upsertMock;

      const total = await storage.bootstrapFromQdrant();
      expect(total).toBe(1); // only the new one counted
    });

    it('passes logger through for progress logging', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => []);
      const logger = { info: vi.fn() };

      await storage.bootstrapFromQdrant(logger);
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'bootstrap' }));
    });
  });
});
