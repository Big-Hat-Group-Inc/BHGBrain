import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStore } from './sqlite.js';
import { mkdtempSync, rmSync } from 'node:fs';
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

  // -- Health --

  it('passes health check', () => {
    expect(store.healthCheck()).toBe(true);
  });
});
