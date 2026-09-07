import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from './sqlite.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';
import type { BrainConfig } from '../config/index.js';

// fix-retrieval-consistency, task 3.3: one shared fixture set exercised
// through every eligibility path a retrieval surface actually uses, so a
// divergence between "storage queries filter expiry in SQL" (search's
// fulltext/list/count paths, design.md decision 1) and "callers apply the
// shared domain predicate to a fetched row" (the exact pattern
// `src/resources/index.ts`'s `isExpiredForResource` and
// `src/tools/index.ts`'s linked-neighbor lookup both use:
// `lifecycle.isExpired(mem.expires_at, now)` against a `getMemoryById`
// result) would fail a test here instead of only surfacing as
// surface-specific drift. Each per-surface test file (sqlite.test.ts,
// search/index.test.ts, resources/index.test.ts, tools/index.test.ts)
// already covers its own call site; this file is the cross-surface tie
// that proves they agree on the identical boundary, using one clock and
// one fixture list rather than each file inventing its own.

describe('retrieval eligibility: cross-surface fixtures (fix-retrieval-consistency)', () => {
  let store: SqliteStore;
  let tempDir: string;
  const lifecycle = new MemoryLifecycleService({
    retention: {
      tier_ttl: { T0: null, T1: 365, T2: 90, T3: 30 },
      auto_promote_access_threshold: 5,
      sliding_window_enabled: true,
      pre_expiry_warning_days: 7,
    },
  } as BrainConfig);

  const now = '2026-09-06T12:00:00.000Z';
  const nowDate = new Date(now);

  const base = (overrides: Record<string, unknown>) => ({
    namespace: 'global',
    collection: 'work',
    type: 'semantic' as const,
    category: null,
    content: 'cross surface eligibility needle',
    summary: 'needle',
    tags: [] as string[],
    source: 'cli' as const,
    importance: 0.5,
    access_count: 0,
    last_operation: 'ADD' as const,
    merged_from: null,
    created_at: '2026-09-06T09:00:00.000Z',
    updated_at: '2026-09-06T09:00:00.000Z',
    last_accessed: '2026-09-06T09:00:00.000Z',
    ...overrides,
  });

  // One fixture list, keyed by scenario, reused by every assertion below —
  // this is the "cross-surface" fixture set itself.
  const fixtures = [
    {
      scenario: 'never expires',
      mem: base({ id: '00000000-0000-0000-0000-0000000000a1', checksum: 'a1', expires_at: null }),
      expectExpired: false,
    },
    {
      scenario: 'future expiry',
      mem: base({ id: '00000000-0000-0000-0000-0000000000a2', checksum: 'a2', expires_at: '2026-09-07T00:00:00.000Z' }),
      expectExpired: false,
    },
    {
      // Exactly at `now`: SQL's `expires_at >= ?` and `isExpired`'s
      // `Date.parse(expiresAt) < now.getTime()` must agree this is NOT
      // expired (spec: "the same clock semantics").
      scenario: 'exactly at the clock boundary',
      mem: base({ id: '00000000-0000-0000-0000-0000000000a3', checksum: 'a3', expires_at: now }),
      expectExpired: false,
    },
    {
      scenario: '1ms past the boundary',
      mem: base({ id: '00000000-0000-0000-0000-0000000000a4', checksum: 'a4', expires_at: '2026-09-06T11:59:59.999Z' }),
      expectExpired: true,
    },
    {
      // Pinned does not exempt a memory from expiry — mirrors
      // resources/index.test.ts's "does not inject a pinned memory whose
      // lifecycle deadline has passed".
      scenario: 'expired but pinned',
      mem: base({
        id: '00000000-0000-0000-0000-0000000000a5', checksum: 'a5',
        expires_at: '2026-09-01T00:00:00.000Z', pinned: true,
      }),
      expectExpired: true,
    },
  ];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-cross-surface-'));
    store = new SqliteStore(tempDir);
    await store.init();
    for (const { mem } of fixtures) {
      store.insertMemory(mem);
    }
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('the domain predicate (resources/tools\' getMemoryById + isExpired path) classifies every fixture as documented', () => {
    for (const { scenario, mem, expectExpired } of fixtures) {
      const fetched = store.getMemoryById(mem.id);
      expect(fetched, scenario).not.toBeNull();
      expect(lifecycle.isExpired(fetched!.expires_at, nowDate), scenario).toBe(expectExpired);
    }
  });

  it('storage-query eligibility (listMemories) agrees with the domain predicate for every fixture', () => {
    const listedIds = new Set(store.listMemories('global', 50, undefined, now).map(m => m.id));
    for (const { scenario, mem, expectExpired } of fixtures) {
      expect(listedIds.has(mem.id), scenario).toBe(!expectExpired);
    }
  });

  it('storage-query eligibility (listMemoriesInCollection) agrees with the domain predicate for every fixture', () => {
    const listedIds = new Set(
      store.listMemoriesInCollection('global', 'work', 50, undefined, now).map(m => m.id),
    );
    for (const { scenario, mem, expectExpired } of fixtures) {
      expect(listedIds.has(mem.id), scenario).toBe(!expectExpired);
    }
  });

  it('storage-query eligibility (fullTextSearch) agrees with the domain predicate for every fixture', () => {
    const matchedIds = new Set(
      store.fullTextSearch('global', 'needle', 50, undefined, undefined, now).map(r => r.id),
    );
    for (const { scenario, mem, expectExpired } of fixtures) {
      expect(matchedIds.has(mem.id), scenario).toBe(!expectExpired);
    }
  });

  it('countMemories reflects exactly the live fixture count at the shared clock', () => {
    const expectedLive = fixtures.filter(f => !f.expectExpired).length;
    expect(store.countMemories('global', now)).toBe(expectedLive);
  });
});
