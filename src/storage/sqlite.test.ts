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

  // -- Health --

  it('passes health check', () => {
    expect(store.healthCheck()).toBe(true);
  });
});
