import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageManager } from './index.js';
import type { SqliteStore } from './sqlite.js';
import type { QdrantStore } from './qdrant.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryRecord } from '../domain/types.js';
import type { MetricsCollector } from '../health/metrics.js';
import { embeddingUnavailable } from '../errors/index.js';

type StoredMemory = Omit<MemoryRecord, 'embedding'>;
type MockSqliteStore = SqliteStore & {
  insertMemory: ReturnType<typeof vi.fn>;
  updateMemory: ReturnType<typeof vi.fn>;
  getCollection: ReturnType<typeof vi.fn>;
  listMemoriesNeedingVectorSync: ReturnType<typeof vi.fn>;
  listMemoryChecksums: ReturnType<typeof vi.fn>;
  markVectorsSyncBatch: ReturnType<typeof vi.fn>;
  listRevisions: ReturnType<typeof vi.fn>;
  insertRevision: ReturnType<typeof vi.fn>;
  insertNextRevision: ReturnType<typeof vi.fn>;
  insertAudit: ReturnType<typeof vi.fn>;
  deleteMemoriesByIds: ReturnType<typeof vi.fn>;
  stageDeletionIntent: ReturnType<typeof vi.fn>;
  clearDeletionIntent: ReturnType<typeof vi.fn>;
  markVectorSyncFailure: ReturnType<typeof vi.fn>;
  listMemoryIds: ReturnType<typeof vi.fn>;
  hydrateBatch: ReturnType<typeof vi.fn>;
  listMemoriesWithStaleEmbeddingStamp: ReturnType<typeof vi.fn>;
};
type MockQdrantStore = QdrantStore & {
  upsert: ReturnType<typeof vi.fn>;
  clearManagedCollections: ReturnType<typeof vi.fn>;
  listAllCollections: ReturnType<typeof vi.fn>;
  scrollAll: ReturnType<typeof vi.fn>;
};

function createMockSqlite(): MockSqliteStore {
  const memoryStore = new Map<string, StoredMemory>();
  const bootstrapHydrationState = new Map<string, {
    collection_name: string; status: 'complete' | 'failed'; hydrated_count: number;
    last_error: string | null; updated_at: string;
  }>();

  return {
    getMemoryById: vi.fn((id: string) => memoryStore.get(id) ?? null),
    insertMemory: vi.fn((mem: StoredMemory) => { memoryStore.set(mem.id, { ...mem }); }),
    updateMemory: vi.fn((id: string, fields: Partial<StoredMemory>) => {
      const existing = memoryStore.get(id);
      if (existing) {
        for (const [k, v] of Object.entries(fields)) {
          // A generic `keyof StoredMemory` index makes TS unable to prove
          // the right-hand union matches the specific per-key property type
          // (it collapses to `never`), so the assignment goes through an
          // `unknown`-keyed view rather than `StoredMemory[typeof key]`.
          (existing as unknown as Record<string, unknown>)[k] = v;
        }
      }
    }),
    deleteMemory: vi.fn((id: string) => memoryStore.delete(id)),
    deleteMemoriesByIds: vi.fn((ids: string[]) => {
      let deleted = 0;
      for (const id of ids) {
        if (memoryStore.delete(id)) deleted++;
      }
      return deleted;
    }),
    // harden-dual-store-mutations tasks 2.1/2.2: SQLite-first deletion
    // staging/compensation. Real `SqliteStore` hides a staged row from reads
    // and clears the pending flag on compensation (see sqlite.test.ts); this
    // mock only tracks the calls themselves — StorageManager's orchestration
    // (call order, which primary/compensation error the caller ultimately
    // sees) is what `describe('StorageManager.deleteMemory ...')`/
    // `describe('deleteMemories SQLite-first staging ...')` below exercise,
    // not the row-hiding behavior already covered at the SqliteStore layer.
    stageDeletionIntent: vi.fn((_ids: string[], _options?: { lifecycleToken?: unknown }) => {}),
    clearDeletionIntent: vi.fn((ids: string[], options?: { lifecycleToken?: unknown; vectorSynced?: boolean }) => {
      // Mirrors SqliteStore.clearDeletionIntent: clears the pending flag and
      // sets vector_synced to the given value (default false), so it stays
      // detectable as cross-store drift until reconciled.
      for (const id of ids) {
        const existing = memoryStore.get(id);
        if (existing) existing.vector_synced = options?.vectorSynced ?? false;
      }
    }),
    markVectorSyncFailure: vi.fn((id: string, _error: string, _permanent: boolean) => {
      const existing = memoryStore.get(id);
      if (existing) existing.vector_synced = false;
    }),
    listMemoryIds: vi.fn(() => new Set(memoryStore.keys())),
    hydrateBatch: vi.fn((
      points: Array<{ id: string; payload: Record<string, unknown> }>,
      existingIds: Set<string>,
    ) => {
      let hydrated = 0;
      const failures: Array<{ id: string; error: string }> = [];
      for (const point of points) {
        if (existingIds.has(point.id)) continue;
        if (typeof point.payload.__throw === 'string') {
          failures.push({ id: point.id, error: point.payload.__throw });
          continue;
        }
        const now = new Date().toISOString();
        memoryStore.set(point.id, {
          id: point.id,
          namespace: 'global',
          collection: 'general',
          type: 'semantic',
          category: null,
          content: typeof point.payload.content === 'string' ? point.payload.content : '',
          summary: typeof point.payload.summary === 'string' ? point.payload.summary : '',
          tags: [],
          source: 'import',
          checksum: '',
          importance: 0.5,
          retention_tier: 'T2',
          expires_at: null,
          decay_eligible: true,
          review_due: null,
          access_count: 0,
          last_operation: 'ADD',
          merged_from: null,
          archived: false,
          vector_synced: true,
          pinned: false,
          origin: null,
          confidence: 1.0,
          created_at: now,
          updated_at: now,
          last_accessed: now,
        });
        existingIds.add(point.id);
        hydrated++;
      }
      return { hydrated, failures };
    }),
    markVectorSync: vi.fn((id: string, synced: boolean) => {
      const existing = memoryStore.get(id);
      if (existing) {
        existing.vector_synced = synced;
      }
    }),
    markVectorsSyncBatch: vi.fn((ids: string[], synced: boolean) => {
      for (const id of ids) {
        const existing = memoryStore.get(id);
        if (existing) {
          existing.vector_synced = synced;
        }
      }
    }),
    listRevisions: vi.fn(() => []),
    insertRevision: vi.fn(),
    insertNextRevision: vi.fn(),
    insertAudit: vi.fn(),
    getCollection: vi.fn(() => ({ name: 'general', namespace: 'global', embedding_model: 'test', embedding_dimensions: 3 })),
    createCollection: vi.fn(),
    listMemoryIdsInCollection: vi.fn(() => ['mem-1']),
    listMemoriesNeedingVectorSync: vi.fn(() => []),
    listMemoryChecksums: vi.fn(() => Array.from(memoryStore.values()).map(mem => ({ id: mem.id, checksum: mem.checksum }))),
    flushIfDirty: vi.fn(),
    countMemories: vi.fn(() => memoryStore.size),
    countUnsyncedVectors: vi.fn(() => Array.from(memoryStore.values()).filter(mem => !mem.vector_synced).length),
    markAllVectorsSyncState: vi.fn((synced: boolean) => {
      for (const memory of memoryStore.values()) {
        memory.vector_synced = synced;
      }
      return memoryStore.size;
    }),
    getExpectedEmbeddingIdentity: vi.fn(() => null),
    adoptEmbeddingIdentityIfAbsent: vi.fn(),
    setExpectedEmbeddingIdentity: vi.fn(),
    countMemoriesWithStaleEmbeddingStamp: vi.fn(() => 0),
    listMemoriesWithStaleEmbeddingStamp: vi.fn(() => []),
    getBootstrapHydrationState: vi.fn(() => Array.from(bootstrapHydrationState.values())),
    setBootstrapCollectionComplete: vi.fn((collectionName: string, hydratedCount: number) => {
      bootstrapHydrationState.set(collectionName, {
        collection_name: collectionName, status: 'complete', hydrated_count: hydratedCount,
        last_error: null, updated_at: new Date().toISOString(),
      });
    }),
    setBootstrapCollectionFailed: vi.fn((collectionName: string, error: string) => {
      bootstrapHydrationState.set(collectionName, {
        collection_name: collectionName, status: 'failed', hydrated_count: 0,
        last_error: error, updated_at: new Date().toISOString(),
      });
    }),
  } as unknown as MockSqliteStore;
}

function createMockQdrant(shouldFail = false): MockQdrantStore {
  const store: MockQdrantStore = {
    upsert: shouldFail
      ? vi.fn(async () => { throw new Error('Qdrant unavailable'); })
      : vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    deleteMany: vi.fn(async () => {}),
    deleteCollection: vi.fn(async () => {}),
    clearManagedCollections: vi.fn(async () => 0),
    listAllCollections: vi.fn(async () => []),
    scrollAll: vi.fn(async (_name: string) => [] as Array<{ id: string; payload: Record<string, unknown> }>),
    // Delegates to whatever `store.scrollAll` currently resolves to (looked
    // up live, not closed over, so a test that replaces the whole
    // `scrollAll` property — not just its resolved value — is still
    // honored), yielded as one page — keeps every existing
    // `scrollAll.mockResolvedValue(...)`/`scrollAll = vi.fn(...)` test setup
    // working against the streaming reconciliation/bootstrap paths unchanged.
    scrollAllPages: vi.fn(async function* (name: string) {
      const points = await store.scrollAll(name);
      if (points.length > 0) yield { points, cursor: null, done: true, cancelled: false };
    }),
  } as unknown as MockQdrantStore;
  return store;
}

function createMockEmbedding(): EmbeddingProvider {
  return {
    provider: 'openai',
    model: 'test',
    dimensions: 3,
    identity: 'openai/test@3',
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
    pinned: false,
    origin: null,
    confidence: 1.0,
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

  describe('device_id provenance round-trip', () => {
    it('tags both the SQLite insert and the Qdrant upsert payload with device_id', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, device_id: 'device-a' }, [1, 2, 3]);

      expect(sqlite.insertMemory).toHaveBeenCalledWith(expect.objectContaining({ device_id: 'device-a' }));
      expect(qdrant.upsert).toHaveBeenCalledWith(
        'global', 'general', 'mem-1', [1, 2, 3],
        expect.objectContaining({ device_id: 'device-a' }),
      );
    });

    it('persists a null device_id when the writer did not supply one', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory(baseMem, [1, 2, 3]);

      expect(qdrant.upsert).toHaveBeenCalledWith(
        'global', 'general', 'mem-1', [1, 2, 3],
        expect.objectContaining({ device_id: null }),
      );
    });
  });

  describe('pinned durability (add-inject-pinning)', () => {
    it('includes pinned: true in the Qdrant payload on writeMemory', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, pinned: true }, [1, 2, 3]);

      expect(qdrant.upsert).toHaveBeenCalledWith(
        'global', 'general', 'mem-1', [1, 2, 3],
        expect.objectContaining({ pinned: true }),
      );
    });

    it('includes pinned: false in the Qdrant payload when unpinned', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, pinned: false }, [1, 2, 3]);

      expect(qdrant.upsert).toHaveBeenCalledWith(
        'global', 'general', 'mem-1', [1, 2, 3],
        expect.objectContaining({ pinned: false }),
      );
    });

    it('carries the existing pinned state into the Qdrant payload on a metadata-only updateMemory', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, pinned: true }, [1, 2, 3]);
      await storage.updateMemory('mem-1', { importance: 0.9 }, [4, 5, 6]);

      expect(qdrant.upsert).toHaveBeenLastCalledWith(
        'global', 'general', 'mem-1', [4, 5, 6],
        expect.objectContaining({ pinned: true }),
      );
    });
  });

  // add-memory-provenance-metadata, task 8.5
  describe('content provenance (origin/confidence) round-trip', () => {
    it('includes origin/confidence in the Qdrant payload on writeMemory', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory(
        { ...baseMem, origin: { session_id: 'sess-1', tool: 'claude-code' }, confidence: 0.8 },
        [1, 2, 3],
      );

      expect(qdrant.upsert).toHaveBeenCalledWith(
        'global', 'general', 'mem-1', [1, 2, 3],
        expect.objectContaining({
          origin: { session_id: 'sess-1', tool: 'claude-code' },
          confidence: 0.8,
        }),
      );
    });

    it('includes a null origin in the Qdrant payload when the writer did not supply one', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, confidence: 1.0 }, [1, 2, 3]);

      expect(qdrant.upsert).toHaveBeenCalledWith(
        'global', 'general', 'mem-1', [1, 2, 3],
        expect.objectContaining({ origin: null }),
      );
    });
  });

  describe('updateMemory projection failure', () => {
    it('does not change SQLite when Qdrant upsert fails', async () => {
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
      ).rejects.toThrow('SQLite remains authoritative and requires reconciliation');

      // The vector projection is attempted before the local update, so no
      // rollback write (and no phantom history) is necessary on failure.
      expect(sqlite.updateMemory).not.toHaveBeenCalled();
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

  describe('T0 revision history', () => {
    it('persists a revision and emits a distinct REVISE audit event when T0 content changes', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, retention_tier: 'T0' }, [1, 2, 3]);

      await storage.updateMemory('mem-1', { content: 'revised content' });

      expect(sqlite.insertNextRevision).toHaveBeenCalledWith('mem-1', 'test content', expect.any(String));
      expect(sqlite.insertAudit).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'REVISE',
        memory_id: 'mem-1',
        namespace: 'global',
        client_id: 'system',
        details: expect.stringContaining('"action":"revise"'),
      }));
    });

    it('does not persist a revision or emit REVISE when a non-T0 memory content changes', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory(baseMem, [1, 2, 3]); // T2

      await storage.updateMemory('mem-1', { content: 'revised content' });

      expect(sqlite.insertNextRevision).not.toHaveBeenCalled();
      expect(sqlite.insertAudit).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'REVISE' }));
    });
  });

  describe('revertMemory', () => {
    it('restores the target revision, re-embeds, bumps history by one, and emits a distinct REVISE audit event', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, retention_tier: 'T0' }, [1, 2, 3]);
      sqlite.listRevisions.mockReturnValue([
        { id: 1, memory_id: 'mem-1', revision: 1, content: 'original content', updated_at: '2026-01-01T00:00:00.000Z', updated_by: null },
      ]);

      const result = await storage.revertMemory('mem-1', 1, 'client-x');

      expect(result.content).toBe('original content');
      expect(embedding.embed).toHaveBeenCalledWith('original content');
      // updateMemory's own T0-content-change gate is what appends the
      // pre-revert content as a new history entry (append-only, not rewritten).
      expect(sqlite.insertNextRevision).toHaveBeenCalledTimes(1);
      expect(sqlite.insertNextRevision).toHaveBeenCalledWith('mem-1', 'test content', expect.any(String));
      expect(sqlite.insertAudit).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'REVISE',
        memory_id: 'mem-1',
        client_id: 'client-x',
        details: expect.stringContaining('"source_revision":1'),
      }));
    });

    it('throws NOT_FOUND when the target revision does not exist, without touching the memory', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, retention_tier: 'T0' }, [1, 2, 3]);
      sqlite.listRevisions.mockReturnValue([]);

      await expect(storage.revertMemory('mem-1', 99, 'client-x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(sqlite.updateMemory).not.toHaveBeenCalled();
      expect(embedding.embed).not.toHaveBeenCalled();
    });

    it('throws EMBEDDING_UNAVAILABLE and leaves the row unchanged when the embedding provider is down', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      embedding.embed = vi.fn(async () => { throw embeddingUnavailable('provider down'); });
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, retention_tier: 'T0' }, [1, 2, 3]);
      sqlite.listRevisions.mockReturnValue([
        { id: 1, memory_id: 'mem-1', revision: 1, content: 'original content', updated_at: '2026-01-01T00:00:00.000Z', updated_by: null },
      ]);

      await expect(storage.revertMemory('mem-1', 1, 'client-x')).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
      expect(sqlite.updateMemory).not.toHaveBeenCalled();
      expect(sqlite.insertNextRevision).not.toHaveBeenCalled();
      expect(sqlite.insertAudit).not.toHaveBeenCalled();
    });

    it('produces an extractive summary of the reverted revision content, not its first line (improve-memory-summarization)', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory({ ...baseMem, retention_tier: 'T0' }, [1, 2, 3]);
      const revisionContent = 'Meeting notes:\nAlice owns the infra repo and handles all deploys.';
      sqlite.listRevisions.mockReturnValue([
        { id: 1, memory_id: 'mem-1', revision: 1, content: revisionContent, updated_at: '2026-01-01T00:00:00.000Z', updated_by: null },
      ]);

      const result = await storage.revertMemory('mem-1', 1, 'client-x');

      expect(result.summary).toBe('Alice owns the infra repo and handles all deploys');
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

    it('increments the degraded-write metric when a metadata-only row is persisted', () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector;
      const storage = new StorageManager(sqlite, qdrant, embedding, metrics);

      sqlite.getCollection = vi.fn(() => null);
      storage.writeMemoryWithoutVector(baseMem);

      expect(metrics.incCounter).toHaveBeenCalledWith('degraded_writes_total');
    });

    it('does not increment the degraded-write metric when the SQLite write fails', () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector;
      const storage = new StorageManager(sqlite, qdrant, embedding, metrics);

      sqlite.getCollection = vi.fn(() => null);
      sqlite.insertMemory = vi.fn(() => { throw new Error('disk full'); });

      expect(() => storage.writeMemoryWithoutVector(baseMem)).toThrow();
      expect(metrics.incCounter).not.toHaveBeenCalled();
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
        embeddingModel: 'openai/test@3',
      });
      expect(sqlite.markVectorSync).toHaveBeenNthCalledWith(2, 'mem-b', true, {
        allowDuringLifecycle: undefined,
        embeddingModel: 'openai/test@3',
      });
      expect(result).toEqual({ reconciled: 2, remaining: 0, failed: 0, permanentFailures: 0, boundReached: false });
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

      const result = await storage.reconcileVectorsFromSqlite({ batchSize: 2 });
      // A transient failure is recorded and the later page still completes.
      expect(result).toEqual({ reconciled: 2, remaining: 0, failed: 1, permanentFailures: 0, boundReached: false });
      expect(sqlite.flushIfDirty).toHaveBeenCalledTimes(2);
      expect(sqlite.getMemoryById('mem-a')?.vector_synced).toBe(true);
      expect(sqlite.getMemoryById('mem-b')?.vector_synced).toBe(true);
    });

    it('stops at the batch cap and reports boundReached so a caller can resume later', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', vector_synced: false });
      sqlite.insertMemory({ ...baseMem, id: 'mem-b', vector_synced: false, checksum: 'chk2' });
      sqlite.listMemoriesNeedingVectorSync
        .mockReturnValueOnce([sqlite.getMemoryById('mem-a')!])
        .mockReturnValueOnce([sqlite.getMemoryById('mem-b')!]);

      const result = await storage.reconcileVectorsFromSqlite({ batchSize: 1, maxBatches: 1 });

      expect(result.reconciled).toBe(1);
      expect(result.boundReached).toBe(true);
      expect(qdrant.upsert).toHaveBeenCalledTimes(1);
      // Only the first batch's cursor lookup happened; the cap stopped the loop
      // before a second `listMemoriesNeedingVectorSync` call.
      expect(sqlite.listMemoriesNeedingVectorSync).toHaveBeenCalledTimes(1);
    });

    it('stops once the timeout elapses even if unsynced memories remain', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', vector_synced: false });
      sqlite.listMemoriesNeedingVectorSync.mockReturnValue([sqlite.getMemoryById('mem-a')!]);

      const result = await storage.reconcileVectorsFromSqlite({ batchSize: 1, timeoutMs: 0 });

      expect(result.reconciled).toBe(0);
      expect(result.boundReached).toBe(true);
      expect(qdrant.upsert).not.toHaveBeenCalled();
    });
  });

  describe('vector drift reconciliation', () => {
    it('marks no memories unsynced and clears nothing when every checksum already matches', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', checksum: 'chk-a', vector_synced: true });
      qdrant.listAllCollections.mockResolvedValue(['bhgbrain_global_general']);
      qdrant.scrollAll.mockResolvedValue([{ id: 'mem-a', payload: { checksum: 'chk-a' } }]);

      const outcome = await storage.detectAndMarkVectorDrift({
        expectedEmbeddingModel: 'test',
        expectedEmbeddingDimensions: 3,
      });

      expect(outcome).toEqual({ mode: 'no-drift', driftedCount: 0, surplusPruned: 0, surplusRemaining: 0 });
      expect(sqlite.markVectorsSyncBatch).not.toHaveBeenCalled();
      expect(qdrant.clearManagedCollections).not.toHaveBeenCalled();
    });

    it('marks only the drifted subset unsynced without clearing managed collections', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', checksum: 'chk-a', vector_synced: true });
      sqlite.insertMemory({ ...baseMem, id: 'mem-b', checksum: 'chk-b-new', vector_synced: true });
      sqlite.insertMemory({ ...baseMem, id: 'mem-c', checksum: 'chk-c', vector_synced: true });
      qdrant.listAllCollections.mockResolvedValue(['bhgbrain_global_general']);
      qdrant.scrollAll.mockResolvedValue([
        { id: 'mem-a', payload: { checksum: 'chk-a' } },
        { id: 'mem-b', payload: { checksum: 'chk-b-old' } },
        // mem-c has no point in Qdrant at all -> treated as drifted/missing.
      ]);

      const outcome = await storage.detectAndMarkVectorDrift({
        expectedEmbeddingModel: 'test',
        expectedEmbeddingDimensions: 3,
      });

      expect(outcome).toEqual({ mode: 'partial-drift', driftedCount: 2, surplusPruned: 0, surplusRemaining: 0 });
      expect(sqlite.markVectorsSyncBatch).toHaveBeenCalledWith(
        expect.arrayContaining(['mem-b', 'mem-c']),
        false,
        { allowDuringLifecycle: undefined },
      );
      expect(qdrant.clearManagedCollections).not.toHaveBeenCalled();
      expect(sqlite.getMemoryById('mem-a')?.vector_synced).toBe(true);
      expect(sqlite.getMemoryById('mem-b')?.vector_synced).toBe(false);
      expect(sqlite.getMemoryById('mem-c')?.vector_synced).toBe(false);
    });

    it('falls back to a full rebuild when the embedding model changed since the backup', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', vector_synced: true });

      const outcome = await storage.detectAndMarkVectorDrift({
        expectedEmbeddingModel: 'old-model',
        expectedEmbeddingDimensions: 3,
      });

      expect(outcome).toEqual({ mode: 'full-rebuild', driftedCount: 1, surplusPruned: 0, surplusRemaining: 0 });
      expect(qdrant.clearManagedCollections).toHaveBeenCalledTimes(1);
      expect(qdrant.listAllCollections).not.toHaveBeenCalled();
      expect(sqlite.getMemoryById('mem-a')?.vector_synced).toBe(false);
    });

    // Task 3.3 (make-backup-restore-transactional): a transient Qdrant read
    // outage is distinguishable from a genuine embedding-model change —
    // both conservatively mark the whole corpus unsynced, but only the
    // model-change case is reported as 'full-rebuild'; an unreadable Qdrant
    // state is its own 'inspection-failed' mode so callers/health never
    // mislabel a retryable read failure as "the embedding model changed".
    it('reports inspection-failed (not full-rebuild) when existing Qdrant state cannot be read', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', vector_synced: true });
      qdrant.listAllCollections.mockRejectedValue(new Error('qdrant unreachable'));

      const outcome = await storage.detectAndMarkVectorDrift({
        expectedEmbeddingModel: 'test',
        expectedEmbeddingDimensions: 3,
      });

      expect(outcome).toEqual({ mode: 'inspection-failed', driftedCount: 1, surplusPruned: 0, surplusRemaining: 0 });
      // Unlike the model-change fallback, an unreadable Qdrant state does
      // not imply the existing vectors are unusable (the embedding space is
      // unchanged), so they are deliberately left in place rather than
      // destroyed on what may be a transient read failure.
      expect(qdrant.clearManagedCollections).not.toHaveBeenCalled();
      expect(sqlite.getMemoryById('mem-a')?.vector_synced).toBe(false);
    });

    // Tasks 3.1/3.2 (make-backup-restore-transactional): a Qdrant point with
    // no corresponding row in the restored SQLite image is a vector-only
    // surplus/orphan and is deleted in bounded batches, without disturbing
    // the SQLite side (no drift is implied by an orphan's mere existence).
    it('prunes a vector-only surplus point that matches this device, leaving matched points untouched', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({
        ...baseMem, id: 'mem-a', checksum: 'chk-a', vector_synced: true, pinned: false, origin: null, confidence: 1,
      });
      qdrant.listAllCollections.mockResolvedValue(['bhgbrain_global_general']);
      qdrant.scrollAll.mockResolvedValue([
        { id: 'mem-a', payload: { checksum: 'chk-a', namespace: 'global', collection: 'general' } },
        // No SQLite row for 'orphan-1' and it's stamped with this device's
        // own id, so it's a genuine restore-time orphan.
        { id: 'orphan-1', payload: { namespace: 'global', collection: 'general', device_id: 'this-device' } },
      ]);

      const outcome = await storage.detectAndMarkVectorDrift({
        expectedEmbeddingModel: 'test',
        expectedEmbeddingDimensions: 3,
        deviceId: 'this-device',
      });

      expect(outcome).toEqual({ mode: 'no-drift', driftedCount: 0, surplusPruned: 1, surplusRemaining: 0 });
      expect(qdrant.deleteMany).toHaveBeenCalledWith('global', 'general', ['orphan-1']);
      expect(sqlite.markVectorsSyncBatch).not.toHaveBeenCalled();
    });

    it('never prunes a surplus point stamped with a different device (the cross-device search fallback)', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      qdrant.listAllCollections.mockResolvedValue(['bhgbrain_global_general']);
      qdrant.scrollAll.mockResolvedValue([
        { id: 'other-device-mem', payload: { namespace: 'global', collection: 'general', device_id: 'other-device' } },
      ]);

      const outcome = await storage.detectAndMarkVectorDrift({
        expectedEmbeddingModel: 'test',
        expectedEmbeddingDimensions: 3,
        deviceId: 'this-device',
      });

      expect(outcome).toEqual({ mode: 'no-drift', driftedCount: 0, surplusPruned: 0, surplusRemaining: 0 });
      expect(qdrant.deleteMany).not.toHaveBeenCalled();
    });

    it('leaves a surplus point unpruned and reports it as remaining when deletion fails', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      qdrant.listAllCollections.mockResolvedValue(['bhgbrain_global_general']);
      qdrant.scrollAll.mockResolvedValue([
        { id: 'orphan-1', payload: { namespace: 'global', collection: 'general' } },
      ]);
      (qdrant.deleteMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('qdrant unreachable'));

      const outcome = await storage.detectAndMarkVectorDrift({
        expectedEmbeddingModel: 'test',
        expectedEmbeddingDimensions: 3,
        deviceId: null,
      });

      expect(outcome).toEqual({ mode: 'no-drift', driftedCount: 0, surplusPruned: 0, surplusRemaining: 1 });
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

      const total = await storage.bootstrapFromQdrant();

      expect(total).toBe(3);
      // One preload of existing ids for the whole run (task 2.3), and one
      // batched hydrateBatch call per collection (task 2.4) rather than a
      // per-point upsert call.
      expect(sqlite.listMemoryIds).toHaveBeenCalledTimes(1);
      expect(sqlite.hydrateBatch).toHaveBeenCalledTimes(2);
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

    it('skips existing rows via the preloaded id Set', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      // Seeded so listMemoryIds() (preloaded once, task 2.3) already contains it.
      sqlite.insertMemory({
        id: 'existing', namespace: 'global', collection: 'general', type: 'semantic', category: null,
        content: 'c0', summary: 's0', tags: [], source: 'cli', checksum: 'chk0', importance: 0.5,
        access_count: 0, last_operation: 'ADD', merged_from: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_accessed: new Date().toISOString(),
      });

      (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => ['bhgbrain_global_general']);
      (qdrant as unknown as Record<string, unknown>).scrollAll = vi.fn(async () => [
        { id: 'existing', payload: { content: 'c1' } },
        { id: 'new', payload: { content: 'c2' } },
      ]);

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

    it('continues hydrating remaining points when one point throws, and does not count it', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => ['bhgbrain_global_general']);
      (qdrant as unknown as Record<string, unknown>).scrollAll = vi.fn(async () => [
        { id: 'p1', payload: { content: 'c1' } },
        { id: 'bad', payload: { content: 'bad', __throw: 'constraint violation' } },
        { id: 'p2', payload: { content: 'c2' } },
      ]);
      const logger = { info: vi.fn(), warn: vi.fn() };

      const total = await storage.bootstrapFromQdrant(logger);

      expect(total).toBe(2); // p1 and p2 counted; bad is not
      expect(sqlite.hydrateBatch).toHaveBeenCalledTimes(1); // one batched call for the collection
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'bootstrap_hydration_failed',
        point_id: 'bad',
      }));
    });

    it('scopes hydration to the given device_id by default, skipping other devices\' points', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => ['bhgbrain_global_general']);
      (qdrant as unknown as Record<string, unknown>).scrollAll = vi.fn(async () => [
        { id: 'mine', payload: { content: 'c1', device_id: 'device-a' } },
        { id: 'theirs', payload: { content: 'c2', device_id: 'device-b' } },
        { id: 'unowned', payload: { content: 'c3' } },
      ]);

      const total = await storage.bootstrapFromQdrant(undefined, { deviceId: 'device-a' });

      expect(total).toBe(1);
      expect(sqlite.hydrateBatch).toHaveBeenCalledTimes(1);
      expect(sqlite.hydrateBatch).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'mine', payload: expect.objectContaining({ device_id: 'device-a' }) })],
        expect.any(Set),
      );
    });

    it('--all-devices hydrates every device regardless of deviceId', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => ['bhgbrain_global_general']);
      (qdrant as unknown as Record<string, unknown>).scrollAll = vi.fn(async () => [
        { id: 'mine', payload: { content: 'c1', device_id: 'device-a' } },
        { id: 'theirs', payload: { content: 'c2', device_id: 'device-b' } },
      ]);

      const total = await storage.bootstrapFromQdrant(undefined, { deviceId: 'device-a', allDevices: true });

      expect(total).toBe(2);
      expect(sqlite.hydrateBatch).toHaveBeenCalledTimes(1);
    });

    // align-runtime-entrypoint-contracts task 3.1
    describe('resumable per-collection hydration', () => {
      it('records a failing collection as failed, continues to the remaining collections, and still returns their hydrated count', async () => {
        const sqlite = createMockSqlite();
        const qdrant = createMockQdrant(false);
        const embedding = createMockEmbedding();
        const storage = new StorageManager(sqlite, qdrant, embedding);

        (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => [
          'bhgbrain_global_broken',
          'bhgbrain_global_general',
        ]);
        (qdrant as unknown as Record<string, unknown>).scrollAll = vi.fn(async (name: string) => {
          if (name === 'bhgbrain_global_broken') {
            throw new Error('Qdrant connection reset');
          }
          return [{ id: 'p1', payload: { content: 'c1' } }];
        });
        const logger = { info: vi.fn(), warn: vi.fn() };

        const total = await storage.bootstrapFromQdrant(logger);

        // The later, healthy collection still hydrates despite the earlier
        // one throwing — a per-collection failure never aborts the whole run.
        expect(total).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
          event: 'bootstrap_hydration_failed',
          collection: 'bhgbrain_global_broken',
        }));

        const state = sqlite.getBootstrapHydrationState();
        expect(state).toContainEqual(expect.objectContaining({
          collection_name: 'bhgbrain_global_broken', status: 'failed',
        }));
        expect(state).toContainEqual(expect.objectContaining({
          collection_name: 'bhgbrain_global_general', status: 'complete', hydrated_count: 1,
        }));
      });

      it('a non-zero local row count from an earlier collection does not suppress retrying a later one that previously failed', async () => {
        const sqlite = createMockSqlite();
        const qdrant = createMockQdrant(false);
        const embedding = createMockEmbedding();
        const storage = new StorageManager(sqlite, qdrant, embedding);

        (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => [
          'bhgbrain_global_general',
          'bhgbrain_global_broken',
        ]);
        let brokenAttempts = 0;
        (qdrant as unknown as Record<string, unknown>).scrollAll = vi.fn(async (name: string) => {
          if (name === 'bhgbrain_global_broken') {
            brokenAttempts++;
            if (brokenAttempts === 1) throw new Error('transient failure');
            return [{ id: 'p2', payload: { content: 'c2' } }];
          }
          return [{ id: 'p1', payload: { content: 'c1' } }];
        });

        // First pass: general hydrates (local row count now > 0), broken fails.
        const firstTotal = await storage.bootstrapFromQdrant(undefined, { skipCompleted: true });
        expect(firstTotal).toBe(1);
        expect(sqlite.countMemories()).toBeGreaterThan(0);

        // Second pass (mirrors a later process startup): general is already
        // 'complete' and is skipped entirely (no second scrollAll call for
        // it); broken is retried and this time succeeds.
        const secondTotal = await storage.bootstrapFromQdrant(undefined, { skipCompleted: true });
        expect(secondTotal).toBe(1);
        expect(brokenAttempts).toBe(2);

        const generalScrollCalls = (qdrant.scrollAll as ReturnType<typeof vi.fn>).mock.calls
          .filter(call => call[0] === 'bhgbrain_global_general');
        expect(generalScrollCalls).toHaveLength(1);

        const state = sqlite.getBootstrapHydrationState();
        expect(state).toContainEqual(expect.objectContaining({
          collection_name: 'bhgbrain_global_broken', status: 'complete',
        }));
      });

      it('without skipCompleted, an already-complete collection is rescanned (repair --from-qdrant behavior is unchanged)', async () => {
        const sqlite = createMockSqlite();
        const qdrant = createMockQdrant(false);
        const embedding = createMockEmbedding();
        const storage = new StorageManager(sqlite, qdrant, embedding);

        (qdrant as unknown as Record<string, unknown>).listAllCollections = vi.fn(async () => ['bhgbrain_global_general']);
        (qdrant as unknown as Record<string, unknown>).scrollAll = vi.fn(async () => [{ id: 'p1', payload: { content: 'c1' } }]);

        await storage.bootstrapFromQdrant(undefined, { skipCompleted: true });
        expect(qdrant.scrollAll).toHaveBeenCalledTimes(1);

        // No skipCompleted (repair's own call site never passes it) — the
        // already-'complete' collection is scanned again, exactly like
        // before durable per-collection state existed.
        await storage.bootstrapFromQdrant();
        expect(qdrant.scrollAll).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('deleteMemories partial failure', () => {
    it('returns a degraded result with unreconciled ids when a group delete throws, leaving that group\'s rows in place and unsynced', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', collection: 'general', vector_synced: true });
      sqlite.insertMemory({ ...baseMem, id: 'mem-b', collection: 'notes', vector_synced: true });

      qdrant.deleteMany = vi.fn(async (_namespace: string, collection: string) => {
        if (collection === 'notes') {
          throw new Error('transient Qdrant error');
        }
      });

      const result = await storage.deleteMemories([
        { id: 'mem-a', namespace: 'global', collection: 'general' },
        { id: 'mem-b', namespace: 'global', collection: 'notes' },
      ]);

      expect(result.deleted).toBe(1);
      expect(result.degraded).toBe(true);
      expect(result.unreconciled).toEqual(['mem-b']);
      // Confirmed group's row is gone; the failed group's row is preserved
      // but explicitly marked unsynced (detectable cross-store drift).
      expect(sqlite.getMemoryById('mem-a')).toBeNull();
      expect(sqlite.getMemoryById('mem-b')).not.toBeNull();
      expect(sqlite.getMemoryById('mem-b')?.vector_synced).toBe(false);
      expect(sqlite.countUnsyncedVectors()).toBe(1);
    });

    it('reports a fully clean pass (not degraded) when every group succeeds', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-a', vector_synced: true });

      const result = await storage.deleteMemories([
        { id: 'mem-a', namespace: 'global', collection: 'general' },
      ]);

      expect(result).toEqual({ deleted: 1, unreconciled: [], degraded: false });
      expect(sqlite.getMemoryById('mem-a')).toBeNull();
      // task 2.2: one chunked deleteMemoriesByIds call, not a deleteMemory loop.
      expect(sqlite.deleteMemoriesByIds).toHaveBeenCalledTimes(1);
      expect(sqlite.deleteMemoriesByIds).toHaveBeenCalledWith(['mem-a']);
    });
  });

  // harden-dual-store-mutations task 2.1: single-delete SQLite-first staging
  // orchestration — stageDeletionIntent before the Qdrant call, so a failure
  // at any boundary leaves recoverable authoritative data or explicit,
  // detectable drift, never a silently-clean row with a deleted vector.
  describe('StorageManager.deleteMemory SQLite-first staging (harden-dual-store-mutations task 2.1)', () => {
    it('stages the deletion intent, then confirms the vector delete, before removing the SQLite row', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);
      sqlite.insertMemory({ ...baseMem, id: 'mem-a' });

      const order: string[] = [];
      const originalDeleteMemoriesByIds = sqlite.deleteMemoriesByIds.getMockImplementation() as (ids: string[]) => number;
      sqlite.stageDeletionIntent.mockImplementation(() => { order.push('stage'); });
      qdrant.delete = vi.fn(async () => { order.push('qdrant-delete'); });
      sqlite.deleteMemoriesByIds.mockImplementation((ids: string[]) => {
        order.push('sqlite-delete');
        return originalDeleteMemoriesByIds(ids);
      });

      const deleted = await storage.deleteMemory('mem-a');

      expect(deleted).toBe(true);
      expect(order).toEqual(['stage', 'qdrant-delete', 'sqlite-delete']);
      expect(sqlite.stageDeletionIntent).toHaveBeenCalledWith(['mem-a']);
      expect(sqlite.clearDeletionIntent).not.toHaveBeenCalled();
    });

    it('a failed Qdrant delete clears the staged intent (compensation) and leaves the SQLite row recoverable', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);
      sqlite.insertMemory({ ...baseMem, id: 'mem-a' });

      qdrant.delete = vi.fn(async () => { throw new Error('qdrant unreachable'); });

      await expect(storage.deleteMemory('mem-a')).rejects.toThrow('Qdrant delete failed: qdrant unreachable');

      // Row survives (the SQLite delete step was never reached), and its
      // pending intent was cleared with vectorSynced:false so it remains
      // visible as detectable cross-store drift rather than silently
      // staying "pending" forever.
      expect(sqlite.deleteMemoriesByIds).not.toHaveBeenCalled();
      expect(sqlite.getMemoryById('mem-a')).not.toBeNull();
      expect(sqlite.clearDeletionIntent).toHaveBeenCalledWith(['mem-a'], { vectorSynced: false });
    });

    it('a confirmed vector delete followed by a failed SQLite delete leaves the tombstone pending and records the failure, not a revived row', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);
      sqlite.insertMemory({ ...baseMem, id: 'mem-a' });

      sqlite.deleteMemoriesByIds.mockImplementation(() => { throw new Error('disk full'); });

      await expect(storage.deleteMemory('mem-a')).rejects.toThrow(
        'SQLite delete failed after Qdrant cleanup; deletion remains pending',
      );

      // No compensation clears the pending intent here — the vector really
      // is gone, so reviving the row would silently desync it again.
      expect(sqlite.clearDeletionIntent).not.toHaveBeenCalled();
      expect(sqlite.insertAudit).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'DELETE',
        memory_id: 'mem-a',
        details: expect.stringContaining('"consistency_error":"disk full"'),
      }));
    });

    it('a compensation failure is logged alongside the primary error, but the primary error is still what the caller sees', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);
      sqlite.insertMemory({ ...baseMem, id: 'mem-a' });

      qdrant.delete = vi.fn(async () => { throw new Error('qdrant unreachable'); });
      sqlite.clearDeletionIntent.mockImplementation(() => { throw new Error('compensation write failed'); });

      // The primary (Qdrant) failure, not the compensation failure, is what
      // propagates to the caller.
      await expect(storage.deleteMemory('mem-a')).rejects.toThrow('Qdrant delete failed: qdrant unreachable');

      expect(sqlite.insertAudit).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'DELETE',
        memory_id: 'mem-a',
        details: expect.stringContaining('"consistency_error":"qdrant unreachable"'),
      }));
      const auditCall = sqlite.insertAudit.mock.calls[0]![0] as { details: string };
      expect(JSON.parse(auditCall.details)).toMatchObject({
        consistency_error: 'qdrant unreachable',
        compensation_error: 'compensation write failed',
      });
    });
  });

  describe('deleteCollectionData vector cleanup failure', () => {
    it('leaves a detectable tombstone and emits a warn signal when Qdrant collection delete fails for a non-not-found reason', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.insertMemory({ ...baseMem, id: 'mem-1', vector_synced: true });
      sqlite.listMemoryIdsInCollection = vi.fn(() => ['mem-1']);
      sqlite.deleteMemoriesInCollection = vi.fn(() => ({ deleted: 0, ids: [] }));
      qdrant.deleteCollection = vi.fn(async () => { throw new Error('qdrant unavailable'); });
      const logger = { warn: vi.fn() };

      await expect(
        storage.deleteCollectionData('global', 'general', { logger }),
      ).rejects.toThrow('vector cleanup incomplete');

      // SQLite row is preserved, not deleted, but no longer reports as synced
      // -> visible to unsynced_vectors / checkVectorReconciliation.
      expect(sqlite.deleteMemoriesInCollection).not.toHaveBeenCalled();
      expect(sqlite.getMemoryById('mem-1')).not.toBeNull();
      expect(sqlite.getMemoryById('mem-1')?.vector_synced).toBe(false);
      expect(sqlite.countUnsyncedVectors()).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'collection_vector_cleanup_failed',
        namespace: 'global',
        collection: 'general',
        memory_ids: ['mem-1'],
      }));
    });

    it('deletes SQLite rows normally when Qdrant collection delete succeeds', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant(false);
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      sqlite.listMemoryIdsInCollection = vi.fn(() => ['mem-1']);
      sqlite.deleteMemoriesInCollection = vi.fn(() => ({ deleted: 1, ids: ['mem-1'] }));

      const result = await storage.deleteCollectionData('global', 'general');

      expect(result).toEqual({ deleted: 1, ids: ['mem-1'] });
      expect(sqlite.markVectorsSyncBatch).not.toHaveBeenCalled();
    });
  });

  // openspec/changes/stamp-embedding-provenance
  describe('embedding provenance', () => {
    it('stamps the active identity on both the SQLite row and the Qdrant payload for a new write', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory(baseMem, [1, 2, 3]);

      expect(sqlite.insertMemory).toHaveBeenCalledWith(
        expect.objectContaining({ embedding_model: 'openai/test@3' }),
      );
      expect(qdrant.upsert).toHaveBeenCalledWith(
        'global', 'general', 'mem-1', [1, 2, 3],
        expect.objectContaining({ embedding_model: 'openai/test@3' }),
      );
      // First compatible write adopts the store's expected identity.
      expect(sqlite.adoptEmbeddingIdentityIfAbsent).toHaveBeenCalledWith('openai/test@3');
    });

    it('stamps the active identity when updateMemory is given a new vector', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory(baseMem, [1, 2, 3]);
      await storage.updateMemory('mem-1', { importance: 0.9 }, [4, 5, 6]);

      expect(sqlite.updateMemory).toHaveBeenCalledWith(
        'mem-1', expect.objectContaining({ embedding_model: 'openai/test@3' }),
      );
      expect(qdrant.upsert).toHaveBeenLastCalledWith(
        'global', 'general', 'mem-1', [4, 5, 6],
        expect.objectContaining({ embedding_model: 'openai/test@3' }),
      );
    });

    it('does not stamp or gate a metadata-only updateMemory (no new vector)', async () => {
      const sqlite = createMockSqlite();
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await storage.writeMemory(baseMem, [1, 2, 3]);
      await storage.updateMemory('mem-1', { importance: 0.9 });

      expect(sqlite.updateMemory).toHaveBeenLastCalledWith('mem-1', { importance: 0.9 });
    });

    it('refuses a vector-producing write when the store expects a different identity (default: refuse on)', async () => {
      const sqlite = createMockSqlite();
      sqlite.getExpectedEmbeddingIdentity = vi.fn(() => 'azure-foundry/old-model@1536');
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const storage = new StorageManager(sqlite, qdrant, embedding);

      await expect(storage.writeMemory(baseMem, [1, 2, 3])).rejects.toThrow(
        /Embedding identity mismatch.*azure-foundry\/old-model@1536.*openai\/test@3/s,
      );
      expect(sqlite.insertMemory).not.toHaveBeenCalled();
      expect(qdrant.upsert).not.toHaveBeenCalled();
    });

    it('permits a mismatched write and stamps the new identity when refuse_writes_on_model_mismatch is false', async () => {
      const sqlite = createMockSqlite();
      sqlite.getExpectedEmbeddingIdentity = vi.fn(() => 'azure-foundry/old-model@1536');
      const qdrant = createMockQdrant();
      const embedding = createMockEmbedding();
      const config = { embedding: { refuse_writes_on_model_mismatch: false } } as unknown as import('../config/index.js').BrainConfig;
      const storage = new StorageManager(sqlite, qdrant, embedding, undefined, config);

      await storage.writeMemory(baseMem, [1, 2, 3]);

      expect(sqlite.insertMemory).toHaveBeenCalledWith(
        expect.objectContaining({ embedding_model: 'openai/test@3' }),
      );
      expect(qdrant.upsert).toHaveBeenCalled();
    });

    describe('reembedMismatchedVectors', () => {
      function memWithStamp(id: string, embeddingModel: string | null): StoredMemory {
        return { ...baseMem, id, embedding_model: embeddingModel } as StoredMemory;
      }

      it('re-embeds mismatched rows in batches and converges the store once none remain', async () => {
        const sqlite = createMockSqlite();
        const qdrant = createMockQdrant();
        const embedding = createMockEmbedding();
        const storage = new StorageManager(sqlite, qdrant, embedding);

        sqlite.listMemoriesWithStaleEmbeddingStamp
          .mockReturnValueOnce([memWithStamp('mem-a', 'azure-foundry/old@1536'), memWithStamp('mem-b', 'azure-foundry/old@1536')])
          .mockReturnValueOnce([]);
        sqlite.countMemoriesWithStaleEmbeddingStamp = vi.fn(() => 0);

        const result = await storage.reembedMismatchedVectors({ batchSize: 2 });

        expect(embedding.embed).toHaveBeenCalledTimes(2);
        expect(qdrant.upsert).toHaveBeenCalledTimes(2);
        expect(sqlite.markVectorSync).toHaveBeenCalledWith('mem-a', true, { embeddingModel: 'openai/test@3' });
        expect(sqlite.markVectorSync).toHaveBeenCalledWith('mem-b', true, { embeddingModel: 'openai/test@3' });
        expect(result).toEqual({ updated: 2, failed: 0, remaining: 0, boundReached: false, converged: true });
        expect(sqlite.setExpectedEmbeddingIdentity).toHaveBeenCalledWith('openai/test@3');
      });

      it('isolates a per-item failure so the rest of the batch still converges, and leaves the failed row unmarked', async () => {
        const sqlite = createMockSqlite();
        const qdrant = createMockQdrant();
        const embedding = createMockEmbedding();
        (embedding.embed as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(new Error('embedding API down'))
          .mockResolvedValueOnce([1, 2, 3]);
        const storage = new StorageManager(sqlite, qdrant, embedding);

        sqlite.listMemoriesWithStaleEmbeddingStamp
          .mockReturnValueOnce([memWithStamp('mem-a', 'azure-foundry/old@1536'), memWithStamp('mem-b', 'azure-foundry/old@1536')])
          .mockReturnValueOnce([]);
        // One row (mem-a) never got re-stamped, so it is still reported stale.
        sqlite.countMemoriesWithStaleEmbeddingStamp = vi.fn(() => 1);

        const result = await storage.reembedMismatchedVectors({ batchSize: 2 });

        expect(result.updated).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.remaining).toBe(1);
        expect(result.converged).toBe(false);
        expect(sqlite.markVectorSync).toHaveBeenCalledTimes(1);
        expect(sqlite.markVectorSync).toHaveBeenCalledWith('mem-b', true, { embeddingModel: 'openai/test@3' });
        expect(sqlite.setExpectedEmbeddingIdentity).not.toHaveBeenCalled();
      });

      it('passes includeLegacy through to selection so legacy (NULL-stamped) rows are only swept in when requested', async () => {
        const sqlite = createMockSqlite();
        const qdrant = createMockQdrant();
        const embedding = createMockEmbedding();
        const storage = new StorageManager(sqlite, qdrant, embedding);
        sqlite.countMemoriesWithStaleEmbeddingStamp = vi.fn(() => 0);

        await storage.reembedMismatchedVectors({ includeLegacy: true, batchSize: 10 });

        expect(sqlite.listMemoriesWithStaleEmbeddingStamp).toHaveBeenCalledWith(
          'openai/test@3', true, 10, undefined,
        );
        expect(sqlite.countMemoriesWithStaleEmbeddingStamp).toHaveBeenCalledWith('openai/test@3', true);
      });

      it('resumes from where it left off: a bounded run does not re-process rows already re-stamped', async () => {
        const sqlite = createMockSqlite();
        const qdrant = createMockQdrant();
        const embedding = createMockEmbedding();
        const storage = new StorageManager(sqlite, qdrant, embedding);

        // maxBatches: 1 stops after the first batch even though more rows
        // remain — simulating an interrupted run. `listMemoriesWithStaleEmbeddingStamp`
        // is re-queried fresh on the next call (not shown here), so a real
        // store's next invocation naturally excludes rows this batch already
        // re-stamped, since they no longer match the stale-stamp predicate.
        sqlite.listMemoriesWithStaleEmbeddingStamp.mockReturnValueOnce([memWithStamp('mem-a', 'azure-foundry/old@1536')]);
        sqlite.countMemoriesWithStaleEmbeddingStamp = vi.fn(() => 5);

        const result = await storage.reembedMismatchedVectors({ batchSize: 1, maxBatches: 1 });

        expect(result.boundReached).toBe(true);
        expect(result.updated).toBe(1);
        expect(result.converged).toBe(false);
        expect(sqlite.setExpectedEmbeddingIdentity).not.toHaveBeenCalled();
      });
    });
  });
});
