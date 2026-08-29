import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteStore } from './sqlite.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SqliteStore', () => {
  let store: SqliteStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-test-'));
    store = new SqliteStore(tempDir);
    await store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const sampleMemory = () => ({
    id: '550e8400-e29b-41d4-a716-446655440000',
    namespace: 'global',
    collection: 'general',
    type: 'semantic' as const,
    category: null,
    content: 'TypeScript generics use extends for constraints',
    summary: 'TypeScript generics use extends for constraints',
    tags: ['typescript', 'generics'],
    source: 'cli' as const,
    checksum: 'abc123',
    importance: 0.7,
    access_count: 0,
    last_operation: 'ADD' as const,
    merged_from: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_accessed: new Date().toISOString(),
  });

  it('inserts and retrieves a memory', () => {
    const mem = sampleMemory();
    store.insertMemory(mem);
    const retrieved = store.getMemoryById(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe(mem.content);
    expect(retrieved!.tags).toEqual(mem.tags);
  });

  it('finds memory by checksum', () => {
    const mem = sampleMemory();
    store.insertMemory(mem);
    const found = store.getMemoryByChecksum('global', 'abc123');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(mem.id);
  });

  it('returns null for missing memory', () => {
    expect(store.getMemoryById('nonexistent')).toBeNull();
  });

  it('deletes a memory', () => {
    const mem = sampleMemory();
    store.insertMemory(mem);
    expect(store.deleteMemory(mem.id)).toBe(true);
    expect(store.getMemoryById(mem.id)).toBeNull();
  });

  // openspec/changes/upgrade-fulltext-to-fts5, task 1.1: the startup FTS5
  // capability probe. This is a canary, not just a smoke test — it is pinned
  // `false` because the pinned sql.js dependency (sql.js@^1.12.0) does not compile
  // in the `fts5` virtual table module (verified: `CREATE VIRTUAL TABLE ... USING
  // fts5` throws "no such module: fts5"). If this ever starts failing because the
  // probe now returns `true`, that is good news — it means sql.js has started
  // shipping fts5, and the engine-level FTS5/BM25 fulltext path (not implemented
  // in this change — see tasks.md notes) can finally be built and tested.
  it('reports FTS5 unavailable against the pinned sql.js build', () => {
    expect(store.isFts5Available()).toBe(false);
  });

  it('counts memories', () => {
    expect(store.countMemories()).toBe(0);
    store.insertMemory(sampleMemory());
    expect(store.countMemories()).toBe(1);
    expect(store.countMemories('global')).toBe(1);
    expect(store.countMemories('other')).toBe(0);
  });

  it('lists memories newest first', () => {
    const mem1 = { ...sampleMemory(), id: '00000000-0000-0000-0000-000000000001', created_at: '2026-01-01T00:00:00Z' };
    const mem2 = { ...sampleMemory(), id: '00000000-0000-0000-0000-000000000002', created_at: '2026-01-02T00:00:00Z', checksum: 'def456' };
    store.insertMemory(mem1);
    store.insertMemory(mem2);
    const list = store.listMemories('global', 10);
    expect(list[0]!.id).toBe(mem2.id);
    expect(list[1]!.id).toBe(mem1.id);
  });

  it('updates memory fields', () => {
    const mem = sampleMemory();
    store.insertMemory(mem);
    store.updateMemory(mem.id, { importance: 0.9, tags: ['ts', 'generics', 'new'] });
    const updated = store.getMemoryById(mem.id)!;
    expect(updated.importance).toBe(0.9);
    expect(updated.tags).toEqual(['ts', 'generics', 'new']);
  });

  it('touches memory access count', () => {
    const mem = sampleMemory();
    store.insertMemory(mem);
    store.touchMemory(mem.id);
    const updated = store.getMemoryById(mem.id)!;
    expect(updated.access_count).toBe(1);
  });

  it('recordAccessBatch applies per-row updates via a reused prepared statement', () => {
    const mem1 = { ...sampleMemory(), id: '550e8400-e29b-41d4-a716-446655440020' };
    const mem2 = { ...sampleMemory(), id: '550e8400-e29b-41d4-a716-446655440021', checksum: 'def456' };
    store.insertMemory(mem1);
    store.insertMemory(mem2);

    store.recordAccessBatch([
      {
        id: mem1.id,
        access_count: 5,
        last_accessed: '2026-02-01T00:00:00Z',
        expires_at: '2026-03-01T00:00:00Z',
        retention_tier: 'T1',
        review_due: '2026-02-15T00:00:00Z',
      },
      // mem2: only the always-present fields are supplied — the tri-state
      // optional fields (expires_at/retention_tier/review_due) are omitted and
      // must be left untouched by the shared prepared statement.
      { id: mem2.id, access_count: 3, last_accessed: '2026-02-02T00:00:00Z' },
    ]);

    const r1 = store.getMemoryById(mem1.id)!;
    expect(r1.access_count).toBe(5);
    expect(r1.last_accessed).toBe('2026-02-01T00:00:00Z');
    expect(r1.expires_at).toBe('2026-03-01T00:00:00Z');
    expect(r1.retention_tier).toBe('T1');
    expect(r1.review_due).toBe('2026-02-15T00:00:00Z');

    const r2 = store.getMemoryById(mem2.id)!;
    expect(r2.access_count).toBe(3);
    expect(r2.last_accessed).toBe('2026-02-02T00:00:00Z');
    expect(r2.expires_at).toBeNull();
    expect(r2.retention_tier).toBe('T2');
    expect(r2.review_due).toBeNull();
  });

  it('recordAccessBatch clears expires_at when explicitly passed null', () => {
    const mem = { ...sampleMemory(), id: '550e8400-e29b-41d4-a716-446655440022' };
    store.insertMemory(mem);
    store.updateMemory(mem.id, { expires_at: '2026-05-01T00:00:00Z' });

    store.recordAccessBatch([
      { id: mem.id, access_count: 1, last_accessed: '2026-02-01T00:00:00Z', expires_at: null },
    ]);

    const updated = store.getMemoryById(mem.id)!;
    expect(updated.expires_at).toBeNull();
  });

  it('lists stale candidate ids before cutoff and excludes categorized memories', () => {
    const stale = {
      ...sampleMemory(),
      id: '550e8400-e29b-41d4-a716-446655440010',
      checksum: 'stale',
      last_accessed: '2025-01-01T00:00:00.000Z',
    };
    const fresh = {
      ...sampleMemory(),
      id: '550e8400-e29b-41d4-a716-446655440011',
      checksum: 'fresh',
      last_accessed: '2027-01-01T00:00:00.000Z',
    };
    const categorized = {
      ...sampleMemory(),
      id: '550e8400-e29b-41d4-a716-446655440012',
      checksum: 'cat',
      category: 'policy',
      last_accessed: '2025-01-01T00:00:00.000Z',
    };
    store.insertMemory(stale);
    store.insertMemory(fresh);
    store.insertMemory(categorized);

    const ids = store.listStaleCandidateIds('2026-01-01T00:00:00.000Z');
    expect(ids).toEqual([stale.id]);
  });

  // -- Categories --

  it('creates and retrieves category', () => {
    const cat = store.setCategory('Coding Standards', 'coding-requirements', 'Use TypeScript strict mode');
    expect(cat.name).toBe('Coding Standards');
    expect(cat.revision).toBe(1);
    const retrieved = store.getCategory('Coding Standards');
    expect(retrieved!.content).toBe('Use TypeScript strict mode');
  });

  it('updates category bumps revision', () => {
    store.setCategory('Test', 'custom', 'v1');
    store.setCategory('Test', 'custom', 'v2');
    const cat = store.getCategory('Test')!;
    expect(cat.revision).toBe(2);
    expect(cat.content).toBe('v2');
  });

  it('lists categories', () => {
    store.setCategory('A', 'custom', 'a');
    store.setCategory('B', 'architecture', 'b');
    const list = store.listCategories();
    expect(list).toHaveLength(2);
  });

  it('deletes category', () => {
    store.setCategory('ToDelete', 'custom', 'temp');
    expect(store.deleteCategory('ToDelete')).toBe(true);
    expect(store.getCategory('ToDelete')).toBeNull();
  });

  // -- Audit --

  it('inserts and lists audit entries', () => {
    store.insertAudit({
      id: 'audit-1',
      timestamp: new Date().toISOString(),
      namespace: 'global',
      operation: 'ADD',
      memory_id: 'mem-1',
      client_id: 'test',
    });
    const entries = store.listAudit(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.operation).toBe('ADD');
  });

  // -- Collections --

  it('creates and lists collections', () => {
    store.createCollection('global', 'test-col', 'text-embedding-3-small', 1536);
    const cols = store.listCollections('global');
    expect(cols).toHaveLength(1);
    expect(cols[0]!.name).toBe('test-col');
  });

  it('counts memories by collection', () => {
    const a = sampleMemory();
    const b = { ...sampleMemory(), id: '550e8400-e29b-41d4-a716-446655440001', checksum: 'def456', collection: 'other' };
    store.insertMemory(a);
    store.insertMemory(b);
    expect(store.countMemoriesInCollection('global', 'general')).toBe(1);
    expect(store.countMemoriesInCollection('global', 'other')).toBe(1);
  });

  it('deletes all memories in a collection and returns deleted ids', () => {
    const a = sampleMemory();
    const b = { ...sampleMemory(), id: '550e8400-e29b-41d4-a716-446655440001', checksum: 'def456', collection: 'general' };
    const c = { ...sampleMemory(), id: '550e8400-e29b-41d4-a716-446655440002', checksum: 'ghi789', collection: 'other' };
    store.insertMemory(a);
    store.insertMemory(b);
    store.insertMemory(c);

    const removed = store.deleteMemoriesInCollection('global', 'general');
    expect(removed.deleted).toBe(2);
    expect(removed.ids.sort()).toEqual([a.id, b.id].sort());
    expect(store.countMemoriesInCollection('global', 'general')).toBe(0);
    expect(store.countMemoriesInCollection('global', 'other')).toBe(1);
  });

  // -- Memory links (add-memory-links) --

  describe('memory_links', () => {
    const memA = () => ({ ...sampleMemory(), id: '10000000-0000-0000-0000-000000000001', checksum: 'link-a' });
    const memB = () => ({ ...sampleMemory(), id: '10000000-0000-0000-0000-000000000002', checksum: 'link-b' });
    const memC = () => ({ ...sampleMemory(), id: '10000000-0000-0000-0000-000000000003', checksum: 'link-c' });

    it('adds an edge and returns created: true', () => {
      store.insertMemory(memA());
      store.insertMemory(memB());
      const { record, created } = store.addMemoryLink('global', memA().id, memB().id, 'refines', 'tester');
      expect(created).toBe(true);
      expect(record.from_id).toBe(memA().id);
      expect(record.to_id).toBe(memB().id);
      expect(record.relation).toBe('refines');
      expect(record.namespace).toBe('global');
      expect(record.created_by).toBe('tester');
      expect(record.created_at).toBeTruthy();
    });

    it('re-adding an identical edge is idempotent, returning the existing row with created: false', () => {
      store.insertMemory(memA());
      store.insertMemory(memB());
      const first = store.addMemoryLink('global', memA().id, memB().id, 'refines', 'tester');
      const second = store.addMemoryLink('global', memA().id, memB().id, 'refines', 'someone-else');
      expect(second.created).toBe(false);
      expect(second.record).toEqual(first.record);
    });

    it('listMemoryLinks returns correct direction for both ends of an edge', () => {
      store.insertMemory(memA());
      store.insertMemory(memB());
      store.addMemoryLink('global', memA().id, memB().id, 'refines', null);

      const fromA = store.listMemoryLinks(memA().id);
      expect(fromA).toHaveLength(1);
      expect(fromA[0]!.direction).toBe('outgoing');

      const fromB = store.listMemoryLinks(memB().id);
      expect(fromB).toHaveLength(1);
      expect(fromB[0]!.direction).toBe('incoming');
    });

    it('listMemoryLinks respects a relation filter', () => {
      store.insertMemory(memA());
      store.insertMemory(memB());
      store.insertMemory(memC());
      store.addMemoryLink('global', memA().id, memB().id, 'refines', null);
      store.addMemoryLink('global', memA().id, memC().id, 'contradicts', null);

      const refinesOnly = store.listMemoryLinks(memA().id, { relation: 'refines' });
      expect(refinesOnly).toHaveLength(1);
      expect(refinesOnly[0]!.to_id).toBe(memB().id);
    });

    it('removeMemoryLink deletes an existing edge and returns true', () => {
      store.insertMemory(memA());
      store.insertMemory(memB());
      store.addMemoryLink('global', memA().id, memB().id, 'refines', null);
      expect(store.removeMemoryLink(memA().id, memB().id, 'refines')).toBe(true);
      expect(store.listMemoryLinks(memA().id)).toHaveLength(0);
    });

    it('removeMemoryLink returns false for a non-existent edge', () => {
      store.insertMemory(memA());
      store.insertMemory(memB());
      expect(store.removeMemoryLink(memA().id, memB().id, 'refines')).toBe(false);
    });

    it('regression: review\'s archive action (archiveMemory then deleteMemory) leaves no orphaned links, same as direct deleteMemory', () => {
      const a = memA();
      const b = memB();
      store.insertMemory(a);
      store.insertMemory(b);
      store.addMemoryLink('global', a.id, b.id, 'refines', null);

      // Exactly the sequence `review`'s `archive` action runs
      // (src/tools/index.ts handleReview): fetch, archiveMemory, then
      // deleteMemory — fetched via getMemoryById so defaulted columns
      // (e.g. retention_tier) are populated, same as the real handler.
      const fetched = store.getMemoryById(a.id)!;
      store.archiveMemory(fetched, new Date().toISOString());
      store.deleteMemory(a.id);

      expect(store.listMemoryLinks(b.id)).toHaveLength(0);
    });

    it('deleteMemory cascades: deleting either endpoint removes the memory_links row', () => {
      store.insertMemory(memA());
      store.insertMemory(memB());
      store.insertMemory(memC());
      store.addMemoryLink('global', memA().id, memB().id, 'refines', null);
      store.addMemoryLink('global', memC().id, memA().id, 'derived_from', null);

      store.deleteMemory(memA().id);

      // memA no longer exists, so links naming it as either endpoint are gone.
      expect(store.listMemoryLinks(memB().id)).toHaveLength(0);
      expect(store.listMemoryLinks(memC().id)).toHaveLength(0);
    });
  });

  // -- Deferred flush --

  it('touchMemory does not synchronously flush', () => {
    const mem = sampleMemory();
    store.insertMemory(mem);
    store.flush(); // flush the insert
    // Now touch and verify no immediate flush occurs
    store.touchMemory(mem.id);
    // The store is dirty but scheduleDeferredFlush should be used by callers
    // Verify data is in-memory even without flush
    const updated = store.getMemoryById(mem.id)!;
    expect(updated.access_count).toBe(1);
  });

  it('scheduleDeferredFlush batches multiple touches', async () => {
    const mem = sampleMemory();
    store.insertMemory(mem);
    store.flush();
    store.touchMemory(mem.id);
    store.touchMemory(mem.id);
    store.scheduleDeferredFlush();
    // In-memory state should reflect both touches
    const updated = store.getMemoryById(mem.id)!;
    expect(updated.access_count).toBe(2);
    // Cancel to avoid timer leak in tests
    store.cancelDeferredFlush();
  });

  it('blocks mutating writes during lifecycle operations and skips access updates', () => {
    const mem = sampleMemory();
    store.insertMemory(mem);
    store.flush();

    store.beginLifecycleOperation('restore');
    expect(() => store.setCategory('Blocked', 'custom', 'nope')).toThrow('lifecycle operation');

    const before = store.getMemoryById(mem.id)!;
    store.touchMemory(mem.id);
    const after = store.getMemoryById(mem.id)!;
    expect(after.access_count).toBe(before.access_count);
    store.endLifecycleOperation('restore');
  });

  // -- Restore/flush race coverage (real SqliteStore, not mocked) --
  //
  // src/backup/index.test.ts stubs SqliteStore entirely (beginLifecycleOperation /
  // endLifecycleOperation / reloadSqliteFromDisk are all vi.fn()), so the real
  // cancelDeferredFlush() call inside beginLifecycleOperation/reloadFromDisk is
  // never exercised there. These tests drive the real timer and real reload path
  // directly against SqliteStore to close that gap.

  it('cancels a pending deferred flush before restore bytes land, so the stale write never overwrites them', async () => {
    vi.useFakeTimers();
    try {
      const mem = sampleMemory();
      store.insertMemory(mem);
      store.flush(); // baseline bytes on disk contain `mem`

      // Dirty the in-memory DB without flushing, then arm the real deferred
      // flush timer -- this is the "pending deferred flush" race scenario.
      store.touchMemory(mem.id);
      store.scheduleDeferredFlush();

      // Mirrors BackupService.beginRestoreOperation(): acquiring the restore
      // lifecycle lock must cancel the pending timer synchronously, before any
      // restored bytes are written to disk.
      store.beginLifecycleOperation('restore');

      // Simulate the restore write: different bytes land on disk directly
      // (bypassing this store's flush()), exactly as atomicWriteFileSync does
      // in BackupService.restore before reloadFromDisk() is called.
      const restoredDir = mkdtempSync(join(tmpdir(), 'bhgbrain-test-restored-'));
      const restoredStore = new SqliteStore(restoredDir);
      await restoredStore.init();
      const restoredMem = { ...sampleMemory(), id: '550e8400-e29b-41d4-a716-446655440099', checksum: 'restored-chk' };
      restoredStore.insertMemory(restoredMem);
      restoredStore.flush();
      const restoredBytes = readFileSync(restoredStore.getDatabasePath());
      restoredStore.close();
      rmSync(restoredDir, { recursive: true, force: true });

      writeFileSync(store.getDatabasePath(), restoredBytes);

      // Advance well past the deferred-flush delay. If the timer had survived
      // (i.e. cancelDeferredFlush() were not actually called), its callback
      // would flush the stale pre-restore in-memory state over the just-written
      // restored bytes.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(readFileSync(store.getDatabasePath()).equals(restoredBytes)).toBe(true);

      // The real reload path: reads afterward observe the restored dataset.
      await store.reloadFromDisk();
      store.endLifecycleOperation('restore');

      expect(store.getMemoryById(mem.id)).toBeNull();
      expect(store.getMemoryById(restoredMem.id)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects markStale, archiveMemory, and ordinary mutations while a restore reload is in flight', async () => {
    const mem = sampleMemory();
    store.insertMemory(mem);
    store.flush();

    store.beginLifecycleOperation('restore');
    const reloadPromise = store.reloadFromDisk();

    // While the reload is in flight -- mirroring the window between
    // BackupService's beginRestoreOperation() and endRestoreLifecycleLock() --
    // every state-mutating path is rejected, including the retention-driven
    // paths (markStale/archiveMemory) that used to bypass the guard.
    expect(() => store.markStale(mem.id)).toThrow(/lifecycle operation/);
    expect(() => store.archiveMemory(mem, new Date().toISOString())).toThrow(/lifecycle operation/);
    expect(() => store.insertMemory({ ...sampleMemory(), id: '550e8400-e29b-41d4-a716-446655440098', checksum: 'racer' })).toThrow(/lifecycle operation/);

    await reloadPromise;
    store.endLifecycleOperation('restore');

    // Guard lifted once the lifecycle operation ends.
    expect(() => store.markStale(mem.id)).not.toThrow();
  });

  // -- upsertMemoryFromPayload (bootstrap) --

  it('upsertMemoryFromPayload inserts a record from Qdrant payload', () => {
    const payload = {
      content: 'bootstrapped content',
      summary: 'bootstrapped summary',
      namespace: 'global',
      collection: 'general',
      type: 'semantic',
      tags: ['imported'],
      importance: 0.8,
      retention_tier: 'T1',
      device_id: 'device-1',
      created_at: '2026-01-01T00:00:00.000Z',
      source: 'api',
      category: null,
      decay_eligible: false,
      checksum: 'qdrant-chk',
    };
    const inserted = store.upsertMemoryFromPayload('bootstrap-id-1', payload);
    expect(inserted).toBe(true);

    const mem = store.getMemoryById('bootstrap-id-1');
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe('bootstrapped content');
    expect(mem!.summary).toBe('bootstrapped summary');
    expect(mem!.importance).toBe(0.8);
    expect(mem!.retention_tier).toBe('T1');
    expect(mem!.device_id).toBe('device-1');
    expect(mem!.source).toBe('api');
    expect(mem!.decay_eligible).toBe(false);
    expect(mem!.vector_synced).toBe(true);
  });

  it('upsertMemoryFromPayload is idempotent — skips existing rows', () => {
    const payload = { content: 'first', summary: 'first', checksum: 'chk1' };
    expect(store.upsertMemoryFromPayload('dup-id', payload)).toBe(true);
    expect(store.upsertMemoryFromPayload('dup-id', { content: 'second', summary: 'second', checksum: 'chk2' })).toBe(false);
    expect(store.getMemoryById('dup-id')!.content).toBe('first');
  });

  it('upsertMemoryFromPayload applies defaults for missing fields', () => {
    const inserted = store.upsertMemoryFromPayload('defaults-id', {});
    expect(inserted).toBe(true);

    const mem = store.getMemoryById('defaults-id')!;
    expect(mem.content).toBe('');
    expect(mem.namespace).toBe('global');
    expect(mem.collection).toBe('general');
    expect(mem.type).toBe('semantic');
    expect(mem.importance).toBe(0.5);
    expect(mem.retention_tier).toBe('T2');
    expect(mem.source).toBe('import');
    expect(mem.decay_eligible).toBe(true);
  });

  it('upsertMemoryFromPayload converts epoch seconds expires_at', () => {
    const epochSec = 1735689600; // 2025-01-01T00:00:00Z
    store.upsertMemoryFromPayload('epoch-id', { expires_at: epochSec, checksum: 'e' });
    const mem = store.getMemoryById('epoch-id')!;
    expect(mem.expires_at).toBe(new Date(epochSec * 1000).toISOString());
  });

  it('upsertMemoryFromPayload populates FTS index for search', () => {
    store.upsertMemoryFromPayload('fts-id', {
      content: 'quantum computing breakthrough',
      summary: 'quantum summary',
      tags: ['physics', 'cs'],
      checksum: 'fts-chk',
    });
    const results = store.fullTextSearch('global', 'quantum', 10);
    expect(results.some(r => r.id === 'fts-id')).toBe(true);
  });

  // -- upsertMemoryFromPayload atomicity regression (audit follow-up 7.x) --

  it('upsertMemoryFromPayload normalizes an out-of-enum type instead of silently dropping the row', () => {
    // A payload whose `type` violates the `memories.type` CHECK constraint must be
    // normalized to the documented default ('semantic'), not silently dropped by
    // INSERT OR IGNORE while an orphan memories_fts row survives.
    const inserted = store.upsertMemoryFromPayload('bad-type-id', {
      content: 'payload with an invalid type field',
      summary: 'invalid type summary',
      type: 'not-a-real-type',
      checksum: 'bad-type-chk',
    });

    expect(inserted).toBe(true);

    const mem = store.getMemoryById('bad-type-id');
    expect(mem).not.toBeNull();
    expect(mem!.type).toBe('semantic');

    // No orphan FTS row: the memory is discoverable via full-text search exactly
    // because the backing `memories` row exists.
    const results = store.fullTextSearch('global', 'invalid type summary', 10);
    expect(results.some(r => r.id === 'bad-type-id')).toBe(true);
  });

  it('upsertMemoryFromPayload rolls back the memories insert if the FTS insert fails, leaving no orphan row and no over-reported success', () => {
    const dbInternal = (store as unknown as { db: { run: (sql: string, params?: unknown[]) => void } }).db;
    const originalRun = dbInternal.run.bind(dbInternal);
    dbInternal.run = (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT OR IGNORE INTO memories_fts')) {
        throw new Error('simulated fts insert failure');
      }
      return originalRun(sql, params);
    };

    try {
      expect(() => store.upsertMemoryFromPayload('atomic-fail-id', {
        content: 'should not persist',
        summary: 'should not persist',
        checksum: 'atomic-fail-chk',
      })).toThrow('simulated fts insert failure');
    } finally {
      dbInternal.run = originalRun;
    }

    // The transaction must have rolled back: no orphan `memories` row either.
    expect(store.getMemoryById('atomic-fail-id')).toBeNull();
    const results = store.fullTextSearch('global', 'should not persist', 10);
    expect(results.some(r => r.id === 'atomic-fail-id')).toBe(false);
  });

  it('fullTextSearch ranks by term-frequency relevance instead of a constant', () => {
    // Low relevance: one body mention.
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000a1', checksum: 'rk-low',
      content: 'a passing mention of vector search here', summary: 'misc note', tags: [],
    });
    // High relevance: repeated mentions plus a tag/summary hit.
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000a2', checksum: 'rk-high',
      content: 'vector vector vector indexing for vector search', summary: 'vector ranking', tags: ['vector'],
    });
    const results = store.fullTextSearch('global', 'vector', 10);
    expect(results.map(r => r.id)).toEqual([
      '00000000-0000-0000-0000-0000000000a2',
      '00000000-0000-0000-0000-0000000000a1',
    ]);
    // Ranks are real relevance scores (distinct, descending), not a constant.
    expect(results[0]!.rank).toBeGreaterThan(results[1]!.rank);
  });

  it('fullTextSearch type filter returns up to limit matching rows instead of starving on higher-ranked non-matches', () => {
    // push-down-recall-filters regression: three higher-relevance 'episodic'
    // rows outrank three lower-relevance 'procedural' rows. A limit of 3 with
    // no filter would return only the episodic rows; pushing the type
    // predicate into the query must return the 3 procedural rows instead of
    // zero (the pre-push-down post-filter would have discarded all 3
    // episodic winners and returned nothing).
    for (let i = 0; i < 3; i++) {
      store.insertMemory({
        ...sampleMemory(), id: `00000000-0000-0000-0000-0000000000c${i}`, checksum: `starve-hi-${i}`,
        type: 'episodic', content: 'widget widget widget widget configuration', summary: 'widget', tags: [],
      });
    }
    for (let i = 0; i < 3; i++) {
      store.insertMemory({
        ...sampleMemory(), id: `00000000-0000-0000-0000-0000000000d${i}`, checksum: `starve-lo-${i}`,
        type: 'procedural', content: 'a single mention of widget configuration', summary: 'widget setup', tags: [],
      });
    }

    const unfiltered = store.fullTextSearch('global', 'widget', 3);
    expect(unfiltered.every(r => r.id.includes('-0000000000c'))).toBe(true);

    const filtered = store.fullTextSearch('global', 'widget', 3, undefined, { type: 'procedural' });
    expect(filtered).toHaveLength(3);
    expect(filtered.every(r => r.id.includes('-0000000000d'))).toBe(true);
  });

  it('fullTextSearch tags filter matches delimiter-aware, not by substring', () => {
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000e1', checksum: 'tag-exact',
      content: 'quarterly budget review notes', summary: 'budget notes', tags: ['finance'],
    });
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000e2', checksum: 'tag-substr',
      content: 'quarterly budget review notes', summary: 'budget notes', tags: ['finance-legacy'],
    });

    const filtered = store.fullTextSearch('global', 'budget', 10, undefined, { tags: ['finance'] });
    expect(filtered.map(r => r.id)).toEqual(['00000000-0000-0000-0000-0000000000e1']);
  });

  it('fullTextSearch after/before filter excludes memories outside the window and includes ones inside it', () => {
    // add-time-scoped-recall: created_at >= after / created_at <= before pushed
    // down into the query, including boundary (exactly-equal) cases.
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000f1', checksum: 'time-before-window',
      content: 'archive summary of decisions', summary: 'archive summary', tags: [],
      created_at: '2026-01-01T00:00:00.000Z',
    });
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000f2', checksum: 'time-lower-bound',
      content: 'archive summary of decisions', summary: 'archive summary', tags: [],
      created_at: '2026-02-01T00:00:00.000Z',
    });
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000f3', checksum: 'time-in-window',
      content: 'archive summary of decisions', summary: 'archive summary', tags: [],
      created_at: '2026-03-01T00:00:00.000Z',
    });
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000f4', checksum: 'time-upper-bound',
      content: 'archive summary of decisions', summary: 'archive summary', tags: [],
      created_at: '2026-04-01T00:00:00.000Z',
    });
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000f5', checksum: 'time-after-window',
      content: 'archive summary of decisions', summary: 'archive summary', tags: [],
      created_at: '2026-05-01T00:00:00.000Z',
    });

    const filtered = store.fullTextSearch('global', 'archive summary', 10, undefined, {
      after: '2026-02-01T00:00:00.000Z', before: '2026-04-01T00:00:00.000Z',
    });
    expect(new Set(filtered.map(r => r.id))).toEqual(new Set([
      '00000000-0000-0000-0000-0000000000f2',
      '00000000-0000-0000-0000-0000000000f3',
      '00000000-0000-0000-0000-0000000000f4',
    ]));
  });

  it('getMemoryByChecksum scopes to collection when provided', () => {
    const inGeneral = { ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000b1', collection: 'general', checksum: 'dup-chk' };
    const inWork = { ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000b2', collection: 'work', checksum: 'dup-chk' };
    store.insertMemory(inGeneral);
    store.insertMemory(inWork);
    // Collection-scoped: identical content in a different collection is not a match.
    expect(store.getMemoryByChecksum('global', 'dup-chk', 'work')!.id).toBe(inWork.id);
    expect(store.getMemoryByChecksum('global', 'dup-chk', 'general')!.id).toBe(inGeneral.id);
    expect(store.getMemoryByChecksum('global', 'dup-chk', 'archive')).toBeNull();
    // Unscoped lookup still finds one (back-compat).
    expect(store.getMemoryByChecksum('global', 'dup-chk')).not.toBeNull();
  });

  it('listMemoriesInCollection scopes by namespace and collection', () => {
    store.insertMemory({ ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000c1', collection: 'work', checksum: 'c1' });
    store.insertMemory({ ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000c2', collection: 'general', checksum: 'c2' });
    store.insertMemory({ ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000c3', namespace: 'other', collection: 'work', checksum: 'c3' });
    const work = store.listMemoriesInCollection('global', 'work', 10);
    expect(work.map(m => m.id)).toEqual(['00000000-0000-0000-0000-0000000000c1']);
  });

  // -- Review queue (add-review-and-archive-recall) --

  it('listReviewDue returns only due, non-archived T1 memories in the namespace, oldest first, paginated', () => {
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000d1', checksum: 'd1',
      retention_tier: 'T1', review_due: '2026-01-01T00:00:00.000Z',
    });
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000d2', checksum: 'd2',
      retention_tier: 'T1', review_due: '2026-02-01T00:00:00.000Z',
    });
    // Not due yet (review_due after the bound) -- excluded.
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000d3', checksum: 'd3',
      retention_tier: 'T1', review_due: '2027-01-01T00:00:00.000Z',
    });
    // Wrong tier -- review_due is set but T1-only listing excludes it.
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000d4', checksum: 'd4',
      retention_tier: 'T2', review_due: '2026-01-15T00:00:00.000Z',
    });
    // Different namespace -- excluded.
    store.insertMemory({
      ...sampleMemory(), id: '00000000-0000-0000-0000-0000000000d5', checksum: 'd5', namespace: 'other',
      retention_tier: 'T1', review_due: '2026-01-01T00:00:00.000Z',
    });

    const before = '2026-06-01T00:00:00.000Z';
    const page1 = store.listReviewDue('global', before, 1);
    expect(page1.map(m => m.id)).toEqual(['00000000-0000-0000-0000-0000000000d1']);

    const cursor = `${page1[0]!.review_due}|${page1[0]!.id}`;
    const page2 = store.listReviewDue('global', before, 1, cursor);
    expect(page2.map(m => m.id)).toEqual(['00000000-0000-0000-0000-0000000000d2']);

    const page3 = store.listReviewDue('global', before, 10);
    expect(page3.map(m => m.id)).toEqual([
      '00000000-0000-0000-0000-0000000000d1',
      '00000000-0000-0000-0000-0000000000d2',
    ]);
  });

  it('searchArchived matches retained summary/tags and scopes to the given namespace', () => {
    const mem = { ...sampleMemory(), namespace: 'global', retention_tier: 'T2' as const };
    store.archiveMemory({ ...mem, summary: 'a note about kubernetes', tags: ['ops'] }, '2026-01-01T00:00:00.000Z');
    store.archiveMemory(
      { ...mem, id: '00000000-0000-0000-0000-0000000000a2', summary: 'unrelated content', tags: ['kubernetes-tag'] },
      '2026-01-02T00:00:00.000Z',
    );
    store.archiveMemory(
      { ...mem, id: '00000000-0000-0000-0000-0000000000a3', namespace: 'other', summary: 'kubernetes in another namespace', tags: [] },
      '2026-01-03T00:00:00.000Z',
    );

    const bySummary = store.searchArchived('global', 'kubernetes', 10);
    expect(bySummary.map(r => r.memory_id).sort()).toEqual([mem.id, '00000000-0000-0000-0000-0000000000a2'].sort());

    const noMatch = store.searchArchived('global', 'nonexistent-term', 10);
    expect(noMatch).toEqual([]);
  });

  // -- Health --

  it('passes health check', () => {
    expect(store.healthCheck()).toBe(true);
  });

  // -- Retention state (GC degraded signal + cleanup lag) --

  it('reports no degraded retention state and null last_success_at before any GC run', () => {
    expect(store.getRetentionDegraded()).toEqual({ degraded: false, message: null, last_success_at: null });
  });

  it('records last_success_at on a clean run and clears it back to healthy', () => {
    store.setRetentionDegraded(false, null, '2026-03-10T02:00:00.000Z');
    expect(store.getRetentionDegraded()).toEqual({
      degraded: false,
      message: null,
      last_success_at: '2026-03-10T02:00:00.000Z',
    });
  });

  it('preserves last_success_at across a subsequent degraded run (cleanup lag keeps growing)', () => {
    store.setRetentionDegraded(false, null, '2026-03-10T02:00:00.000Z');
    store.setRetentionDegraded(true, 'archive failed', '2026-03-11T02:00:00.000Z');
    expect(store.getRetentionDegraded()).toEqual({
      degraded: true,
      message: 'archive failed',
      last_success_at: '2026-03-10T02:00:00.000Z', // unchanged: the failed run didn't complete cleanly
    });
  });

  it('advances last_success_at again once a later run completes cleanly', () => {
    store.setRetentionDegraded(false, null, '2026-03-10T02:00:00.000Z');
    store.setRetentionDegraded(true, 'archive failed', '2026-03-11T02:00:00.000Z');
    store.setRetentionDegraded(false, null, '2026-03-12T02:00:00.000Z');
    expect(store.getRetentionDegraded()).toEqual({
      degraded: false,
      message: null,
      last_success_at: '2026-03-12T02:00:00.000Z',
    });
  });
});

// openspec/changes/stamp-embedding-provenance
describe('SqliteStore embedding provenance', () => {
  let store: SqliteStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-test-'));
    store = new SqliteStore(tempDir);
    await store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function baseMemory() {
    return {
      id: '550e8400-e29b-41d4-a716-446655440000',
      namespace: 'global',
      collection: 'general',
      type: 'semantic' as const,
      category: null,
      content: 'test content',
      summary: 'test content',
      tags: [] as string[],
      source: 'cli' as const,
      checksum: 'abc123',
      importance: 0.5,
      access_count: 0,
      last_operation: 'ADD' as const,
      merged_from: null,
      embedding_model: null as string | null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_accessed: new Date().toISOString(),
    };
  }
  const sampleMemory = (overrides: Partial<ReturnType<typeof baseMemory>> = {}) => ({ ...baseMemory(), ...overrides });

  it('a fresh store has no expected embedding identity', () => {
    expect(store.getExpectedEmbeddingIdentity()).toBeNull();
  });

  it('adoptEmbeddingIdentityIfAbsent sets the expectation only the first time', () => {
    store.adoptEmbeddingIdentityIfAbsent('openai/text-embedding-3-small@1536');
    expect(store.getExpectedEmbeddingIdentity()).toBe('openai/text-embedding-3-small@1536');

    // A second adopt call with a different identity is a no-op: adoption only
    // ever happens once, absent an explicit setExpectedEmbeddingIdentity.
    store.adoptEmbeddingIdentityIfAbsent('azure-foundry/other@1536');
    expect(store.getExpectedEmbeddingIdentity()).toBe('openai/text-embedding-3-small@1536');
  });

  it('setExpectedEmbeddingIdentity unconditionally overwrites the expectation', () => {
    store.adoptEmbeddingIdentityIfAbsent('openai/text-embedding-3-small@1536');
    store.setExpectedEmbeddingIdentity('azure-foundry/other@1536');
    expect(store.getExpectedEmbeddingIdentity()).toBe('azure-foundry/other@1536');
  });

  it('stores and round-trips a null embedding_model for a row that never specifies one', () => {
    store.insertMemory(sampleMemory());
    const mem = store.getMemoryById('550e8400-e29b-41d4-a716-446655440000');
    expect(mem?.embedding_model).toBeNull();
  });

  it('stores and round-trips a non-null embedding_model', () => {
    store.insertMemory(sampleMemory({ embedding_model: 'openai/text-embedding-3-small@1536' }));
    const mem = store.getMemoryById('550e8400-e29b-41d4-a716-446655440000');
    expect(mem?.embedding_model).toBe('openai/text-embedding-3-small@1536');
  });

  it('updateMemory can change the embedding_model stamp', () => {
    store.insertMemory(sampleMemory({ embedding_model: 'openai/old@1536' }));
    store.updateMemory('550e8400-e29b-41d4-a716-446655440000', { embedding_model: 'openai/new@1536' });
    const mem = store.getMemoryById('550e8400-e29b-41d4-a716-446655440000');
    expect(mem?.embedding_model).toBe('openai/new@1536');
  });

  describe('stale embedding stamp selection', () => {
    const activeIdentity = 'openai/text-embedding-3-small@1536';

    beforeEach(() => {
      store.insertMemory(sampleMemory({
        id: '00000000-0000-0000-0000-000000000001', embedding_model: activeIdentity,
      }));
      store.insertMemory(sampleMemory({
        id: '00000000-0000-0000-0000-000000000002', embedding_model: 'azure-foundry/old@1536',
      }));
      store.insertMemory(sampleMemory({
        id: '00000000-0000-0000-0000-000000000003', embedding_model: null,
      }));
    });

    it('excludes rows already matching the active identity and legacy (NULL) rows by default', () => {
      expect(store.countMemoriesWithStaleEmbeddingStamp(activeIdentity, false)).toBe(1);
      const rows = store.listMemoriesWithStaleEmbeddingStamp(activeIdentity, false, 10);
      expect(rows.map(r => r.id)).toEqual(['00000000-0000-0000-0000-000000000002']);
    });

    it('includes legacy (NULL) rows when includeLegacy is true', () => {
      expect(store.countMemoriesWithStaleEmbeddingStamp(activeIdentity, true)).toBe(2);
      const rows = store.listMemoriesWithStaleEmbeddingStamp(activeIdentity, true, 10);
      expect(rows.map(r => r.id).sort()).toEqual([
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000003',
      ]);
    });

    it('a row re-stamped with the active identity stops matching the selection (convergence)', () => {
      store.updateMemory('00000000-0000-0000-0000-000000000002', { embedding_model: activeIdentity });
      expect(store.countMemoriesWithStaleEmbeddingStamp(activeIdentity, false)).toBe(0);
    });
  });
});

describe('SqliteStore pinned memories (add-inject-pinning)', () => {
  let store: SqliteStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-test-'));
    store = new SqliteStore(tempDir);
    await store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function baseMemory() {
    return {
      id: '550e8400-e29b-41d4-a716-446655440000',
      namespace: 'global',
      collection: 'general',
      type: 'semantic' as const,
      category: null,
      content: 'test content',
      summary: 'test content',
      tags: [] as string[],
      source: 'cli' as const,
      checksum: 'abc123',
      importance: 0.5,
      access_count: 0,
      last_operation: 'ADD' as const,
      merged_from: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_accessed: new Date().toISOString(),
    };
  }
  const sampleMemory = (overrides: Partial<ReturnType<typeof baseMemory>> = {}) => ({ ...baseMemory(), ...overrides });

  it('defaults pinned to false when omitted on insert', () => {
    store.insertMemory(sampleMemory());
    expect(store.getMemoryById('550e8400-e29b-41d4-a716-446655440000')!.pinned).toBe(false);
  });

  it('persists an explicit pinned: true on insert', () => {
    store.insertMemory({ ...sampleMemory(), pinned: true });
    expect(store.getMemoryById('550e8400-e29b-41d4-a716-446655440000')!.pinned).toBe(true);
  });

  it('updateMemory sets and clears pinned via the boolean-coercion branch', () => {
    store.insertMemory(sampleMemory());
    store.updateMemory('550e8400-e29b-41d4-a716-446655440000', { pinned: true });
    expect(store.getMemoryById('550e8400-e29b-41d4-a716-446655440000')!.pinned).toBe(true);
    store.updateMemory('550e8400-e29b-41d4-a716-446655440000', { pinned: false });
    expect(store.getMemoryById('550e8400-e29b-41d4-a716-446655440000')!.pinned).toBe(false);
  });

  it('listPinnedMemories returns only pinned, non-archived memories for the namespace, newest-updated first', () => {
    store.insertMemory(sampleMemory({ id: '00000000-0000-0000-0000-000000000001', checksum: 'a' }));
    store.insertMemory(sampleMemory({ id: '00000000-0000-0000-0000-000000000002', checksum: 'b' }));
    store.insertMemory(sampleMemory({
      id: '00000000-0000-0000-0000-000000000003', checksum: 'c', namespace: 'other',
    }));
    store.updateMemory('00000000-0000-0000-0000-000000000001', { pinned: true, updated_at: '2026-01-01T00:00:00Z' });
    store.updateMemory('00000000-0000-0000-0000-000000000002', { pinned: true, updated_at: '2026-01-02T00:00:00Z' });
    store.updateMemory('00000000-0000-0000-0000-000000000003', { pinned: true });

    const pinned = store.listPinnedMemories('global');
    expect(pinned.map(m => m.id)).toEqual([
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000001',
    ]);
  });

  it('listPinnedMemories excludes archived memories', () => {
    store.insertMemory(sampleMemory());
    store.updateMemory('550e8400-e29b-41d4-a716-446655440000', { pinned: true, archived: true });
    expect(store.listPinnedMemories('global')).toEqual([]);
  });

  it('countPinnedMemories is scoped per namespace', () => {
    store.insertMemory(sampleMemory({ id: '00000000-0000-0000-0000-000000000001', checksum: 'a' }));
    store.insertMemory(sampleMemory({
      id: '00000000-0000-0000-0000-000000000002', checksum: 'b', namespace: 'other',
    }));
    store.updateMemory('00000000-0000-0000-0000-000000000001', { pinned: true });
    store.updateMemory('00000000-0000-0000-0000-000000000002', { pinned: true });

    expect(store.countPinnedMemories('global')).toBe(1);
    expect(store.countPinnedMemories('other')).toBe(1);
    expect(store.countPinnedMemories('nonexistent')).toBe(0);
  });

  it('upsertMemoryFromPayload restores pinned: true from the payload (repair --mode from-qdrant durability)', () => {
    store.upsertMemoryFromPayload('550e8400-e29b-41d4-a716-446655440099', {
      content: 'restored content',
      summary: 'restored',
      namespace: 'global',
      collection: 'general',
      type: 'semantic',
      pinned: true,
    });
    expect(store.getMemoryById('550e8400-e29b-41d4-a716-446655440099')!.pinned).toBe(true);
  });

  it('upsertMemoryFromPayload defaults pinned to false when absent from the payload', () => {
    store.upsertMemoryFromPayload('550e8400-e29b-41d4-a716-446655440098', {
      content: 'restored content',
      summary: 'restored',
      namespace: 'global',
      collection: 'general',
      type: 'semantic',
    });
    expect(store.getMemoryById('550e8400-e29b-41d4-a716-446655440098')!.pinned).toBe(false);
  });
});
