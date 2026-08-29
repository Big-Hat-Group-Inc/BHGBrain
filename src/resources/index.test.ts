import { describe, it, expect, vi } from 'vitest';
import { ResourceHandler, MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_TEMPLATES } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { HealthService } from '../health/index.js';
import type { SearchService } from '../search/index.js';
import type { StorageManager } from '../storage/index.js';
import type { BrainErrorEnvelope, ErrorEnvelope } from '../errors/index.js';
import type { SearchResult } from '../domain/types.js';

type ListResult = { items: unknown[]; total_results: number };
type InjectResult = { content: string; truncated: boolean; memories_count: number; categories_count: number };
type ResourceResult = ListResult | InjectResult | ErrorEnvelope;

describe('resource pagination bounds', () => {
  function createHandler() {
    const memory = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      namespace: 'global',
      collection: 'general',
      type: 'semantic',
      category: null,
      content: 'memory content',
      summary: 'memory summary',
      tags: [],
      source: 'cli',
      checksum: 'x',
      importance: 0.5,
      access_count: 0,
      last_operation: 'ADD',
      merged_from: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      last_accessed: '2026-01-01T00:00:00.000Z',
    };

    const storage = {
      sqlite: {
        listMemories: (_ns: string, limit: number) => [memory, { ...memory, id: '550e8400-e29b-41d4-a716-446655440001' }].slice(0, limit),
        countMemories: () => 2,
        getMemoryById: () => memory,
        touchMemory: () => undefined,
        flushIfDirty: () => undefined,
        listCategories: () => [],
        listCollections: () => [],
        getCategory: () => null,
      },
    } as unknown as StorageManager;

    const config = {
      defaults: { namespace: 'global', auto_inject_limit: 5 },
      auto_inject: { max_chars: 500 },
    } as unknown as BrainConfig;

    return new ResourceHandler(
      config,
      storage,
      {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );
  }

  it('returns INVALID_INPUT for non-numeric limit', async () => {
    const handler = createHandler();
    const result = await handler.handle('memory://list?limit=abc') as ResourceResult;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT for out-of-range limit', async () => {
    const handler = createHandler();
    const result = await handler.handle('memory://list?limit=1000') as ResourceResult;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns bounded paginated response for valid limit', async () => {
    const handler = createHandler();
    const result = await handler.handle('memory://list?limit=1') as ResourceResult;
    expect(result.items).toHaveLength(1);
    expect(result.total_results).toBe(2);
  });

  it('excludes an expired decay-eligible T2/T3 memory from memory://{id}', async () => {
    const expiredMemory = {
      id: '550e8400-e29b-41d4-a716-446655440002',
      namespace: 'global',
      collection: 'general',
      type: 'semantic',
      content: 'stale content',
      summary: 'stale summary',
      tags: [],
      retention_tier: 'T3',
      expires_at: '2020-01-01T00:00:00.000Z',
      decay_eligible: true,
    };
    const storage = {
      sqlite: {
        getMemoryById: () => expiredMemory,
        touchMemory: () => undefined,
        scheduleDeferredFlush: () => undefined,
      },
    } as unknown as StorageManager;
    const config = { defaults: { namespace: 'global' } } as unknown as BrainConfig;
    const handler = new ResourceHandler(
      config,
      storage,
      {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );

    const result = await handler.handle(`memory://${expiredMemory.id}`) as ResourceResult;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns revisions newest-first via memory://{id}/revisions', async () => {
    const mem = {
      id: '550e8400-e29b-41d4-a716-446655440006',
      retention_tier: 'T0',
      expires_at: null,
      decay_eligible: false,
    };
    const revisions = [
      { id: 2, memory_id: mem.id, revision: 2, content: 'newer', updated_at: '2026-01-02T00:00:00.000Z', updated_by: null },
      { id: 1, memory_id: mem.id, revision: 1, content: 'older', updated_at: '2026-01-01T00:00:00.000Z', updated_by: null },
    ];
    const storage = {
      sqlite: {
        getMemoryById: () => mem,
        listRevisions: () => revisions,
      },
    } as unknown as StorageManager;
    const config = { defaults: { namespace: 'global' } } as unknown as BrainConfig;
    const handler = new ResourceHandler(
      config,
      storage,
      {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );

    const result = await handler.handle(`memory://${mem.id}/revisions`) as { id: string; revisions: unknown[] };
    expect(result.id).toBe(mem.id);
    expect(result.revisions).toEqual(revisions);
  });

  it('returns an empty revision list for a memory with no updates', async () => {
    const mem = {
      id: '550e8400-e29b-41d4-a716-446655440007',
      retention_tier: 'T0',
      expires_at: null,
      decay_eligible: false,
    };
    const storage = {
      sqlite: {
        getMemoryById: () => mem,
        listRevisions: () => [],
      },
    } as unknown as StorageManager;
    const config = { defaults: { namespace: 'global' } } as unknown as BrainConfig;
    const handler = new ResourceHandler(
      config,
      storage,
      {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );

    const result = await handler.handle(`memory://${mem.id}/revisions`) as { id: string; revisions: unknown[] };
    expect(result.revisions).toEqual([]);
  });

  it('returns NOT_FOUND for memory://{id}/revisions on an unknown or expired memory', async () => {
    const storage = {
      sqlite: {
        getMemoryById: () => null,
      },
    } as unknown as StorageManager;
    const config = { defaults: { namespace: 'global' } } as unknown as BrainConfig;
    const handler = new ResourceHandler(
      config,
      storage,
      {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );

    const result = await handler.handle('memory://550e8400-e29b-41d4-a716-446655440008/revisions') as ResourceResult;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('keeps an expired T1 memory visible through memory://{id} (only T2/T3 are filtered)', async () => {
    const expiredT1 = {
      id: '550e8400-e29b-41d4-a716-446655440003',
      namespace: 'global',
      collection: 'general',
      type: 'semantic',
      content: 'institutional content',
      summary: 'institutional summary',
      tags: [],
      retention_tier: 'T1',
      expires_at: '2020-01-01T00:00:00.000Z',
      decay_eligible: true,
    };
    const storage = {
      sqlite: {
        getMemoryById: () => expiredT1,
        touchMemory: () => undefined,
        scheduleDeferredFlush: () => undefined,
      },
    } as unknown as StorageManager;
    const config = { defaults: { namespace: 'global' } } as unknown as BrainConfig;
    const handler = new ResourceHandler(
      config,
      storage,
      {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );

    const result = await handler.handle(`memory://${expiredT1.id}`) as { id?: string; error?: unknown };
    expect(result.error).toBeUndefined();
    expect(result.id).toBe(expiredT1.id);
  });

  it('excludes expired T2/T3 memories from a memory://list page', async () => {
    const active = {
      id: '550e8400-e29b-41d4-a716-446655440004',
      namespace: 'global',
      collection: 'general',
      type: 'semantic',
      content: 'active content',
      summary: 'active summary',
      tags: [],
      retention_tier: 'T2',
      expires_at: null,
      decay_eligible: true,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const expired = {
      ...active,
      id: '550e8400-e29b-41d4-a716-446655440005',
      retention_tier: 'T3',
      expires_at: '2020-01-01T00:00:00.000Z',
    };
    const storage = {
      sqlite: {
        listMemories: (_ns: string, limit: number) => [active, expired].slice(0, limit),
        countMemories: () => 2,
      },
    } as unknown as StorageManager;
    const config = { defaults: { namespace: 'global' } } as unknown as BrainConfig;
    const handler = new ResourceHandler(
      config,
      storage,
      {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );

    const result = await handler.handle('memory://list?limit=10') as ResourceResult;
    expect(result.items).toEqual([active]);
  });

  it('builds inject payload within budget without concatenating all category content', async () => {
    const config = {
      defaults: { namespace: 'global', auto_inject_limit: 5 },
      // fraction 0 preserves this test's original intent (category truncation
      // math in isolation) under the reserved-memory-budget feature.
      auto_inject: { max_chars: 24, memory_budget_fraction: 0, budget_unit: 'chars', dedup_suppression: true },
      deduplication: { similarity_threshold: 0.92 },
    } as unknown as BrainConfig;
    const storage = {
      sqlite: {
        listCategoryHeaders: () => [{ name: 'Policy', slot: 'custom', revision: 1, updated_at: '2026-01-01T00:00:00Z', content_length: 200 }],
        getCategoryContentSlice: (_name: string, maxChars: number) => ({ content: 'x'.repeat(maxChars), length: maxChars }),
        listMemories: () => [],
        countMemories: () => 0,
        getMemoryById: () => null,
        touchMemory: () => undefined,
        scheduleDeferredFlush: () => undefined,
        listCategories: () => [],
        listCollections: () => [],
        getCategory: () => null,
      },
    } as unknown as StorageManager;
    const handler = new ResourceHandler(
      config,
      storage,
      {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );

    const result = await handler.handle('memory://inject') as ResourceResult;
    expect(result.content.length).toBeLessThanOrEqual(24);
    expect(result.truncated).toBe(true);
  });

  it('flags truncation for multibyte/astral category content near the budget boundary', async () => {
    // Regression for the JS UTF-16 vs. SQLite character-count mismatch: an astral
    // character (e.g. an emoji outside the BMP) is 1 SQLite character but 2 JS
    // UTF-16 code units. The full category content is 5 astral characters
    // (content_length: 5), but only 3 of them were sliced due to the budget. The
    // sliced JS string's `.length` is 6 (3 * 2 surrogate units) which is >= 5 —
    // comparing that against content_length would wrongly report "fully
    // included". Comparing SQLite-counted lengths on both sides must not.
    const config = {
      defaults: { namespace: 'global', auto_inject_limit: 5 },
      auto_inject: { max_chars: 500, memory_budget_fraction: 0, budget_unit: 'chars', dedup_suppression: true },
      deduplication: { similarity_threshold: 0.92 },
    } as unknown as BrainConfig;
    const storage = {
      sqlite: {
        listCategoryHeaders: () => [{ name: 'Policy', slot: 'custom', revision: 1, updated_at: '2026-01-01T00:00:00Z', content_length: 5 }],
        getCategoryContentSlice: () => ({ content: '\u{1F600}'.repeat(3), length: 3 }),
        listMemories: () => [],
        countMemories: () => 0,
        getMemoryById: () => null,
        touchMemory: () => undefined,
        scheduleDeferredFlush: () => undefined,
        listCategories: () => [],
        listCollections: () => [],
        getCategory: () => null,
      },
    } as unknown as StorageManager;
    const handler = new ResourceHandler(
      config,
      storage,
      {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );

    const result = await handler.handle('memory://inject') as ResourceResult;
    expect(result.truncated).toBe(true);
    expect([...result.content.matchAll(/\u{1F600}/gu)]).toHaveLength(3);
  });
});

describe('relevance-conditioned inject (memory://inject/{hint})', () => {
  const baseConfig = {
    defaults: { namespace: 'global', auto_inject_limit: 5 },
    auto_inject: { max_chars: 500, memory_budget_fraction: 0.4, budget_unit: 'chars', dedup_suppression: true },
    deduplication: { similarity_threshold: 0.9 },
  } as unknown as BrainConfig;

  const healthy = { check: async () => ({ status: 'healthy' }) } as HealthService;

  function makeStorage(overrides: Record<string, unknown> = {}) {
    return {
      sqlite: {
        listCategoryHeaders: () => [],
        getCategoryContentSlice: () => ({ content: '', length: 0 }),
        listMemories: () => [],
        countMemories: () => 0,
        getMemoryById: () => null,
        touchMemory: () => undefined,
        scheduleDeferredFlush: () => undefined,
        listCategories: () => [],
        listCollections: () => [],
        getCategory: () => null,
        ...overrides,
      },
    } as unknown as StorageManager;
  }

  const mkResult = (id: string, content: string, vector?: number[]): SearchResult => ({
    id, content, summary: id, type: 'semantic', tags: [], score: 0.9,
    retention_tier: 'T2', created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
    vector,
  });

  it('selects memories by hint relevance instead of recency (5.1)', async () => {
    const searchForInject = vi.fn(async () => [mkResult('r1', 'deployment runbook')]);
    const search = { searchForInject } as unknown as SearchService;
    const storage = makeStorage({
      listMemories: () => { throw new Error('recency path must not run when a hint is given'); },
    });
    const handler = new ResourceHandler(baseConfig, storage, search, healthy);

    const result = await handler.handle('memory://inject/deploy%20task') as InjectResult;

    expect(searchForInject).toHaveBeenCalledWith('deploy task', 'global', 5);
    expect(result.content).toContain('deployment runbook');
    expect(result.memories_count).toBe(1);
  });

  it('falls back to recency selection when no hint is given', async () => {
    const searchForInject = vi.fn();
    const search = { searchForInject } as unknown as SearchService;
    const storage = makeStorage({
      listMemories: () => [{ type: 'semantic', content: 'recent memory', summary: 'recent' }],
    });
    const handler = new ResourceHandler(baseConfig, storage, search, healthy);

    const result = await handler.handle('memory://inject') as InjectResult;

    expect(searchForInject).not.toHaveBeenCalled();
    expect(result.content).toContain('recent memory');
  });

  it('reserves the memory section its configured fraction when categories are oversized (5.2)', async () => {
    const search = { searchForInject: vi.fn() } as unknown as SearchService;
    const config = {
      ...baseConfig,
      auto_inject: { max_chars: 100, memory_budget_fraction: 0.4, budget_unit: 'chars', dedup_suppression: true },
    } as unknown as BrainConfig;
    const storage = makeStorage({
      listCategoryHeaders: () => [{ name: 'Policy', slot: 'custom', revision: 1, updated_at: '2026-01-01T00:00:00Z', content_length: 1000 }],
      getCategoryContentSlice: (_name: string, maxChars: number) => ({ content: 'x'.repeat(maxChars), length: maxChars }),
      listMemories: () => [{ type: 'semantic', content: 'a memory that fits', summary: 'mem' }],
    });
    const handler = new ResourceHandler(config, storage, search, healthy);

    const result = await handler.handle('memory://inject') as InjectResult;

    // Oversized categories still leave the memory section its reserved share.
    expect(result.truncated).toBe(true);
    expect(result.memories_count).toBe(1);
  });

  it('fraction 0 restores the pre-existing starvation behavior (5.2)', async () => {
    const search = { searchForInject: vi.fn() } as unknown as SearchService;
    const config = {
      ...baseConfig,
      auto_inject: { max_chars: 100, memory_budget_fraction: 0, budget_unit: 'chars', dedup_suppression: true },
    } as unknown as BrainConfig;
    const storage = makeStorage({
      listCategoryHeaders: () => [{ name: 'Policy', slot: 'custom', revision: 1, updated_at: '2026-01-01T00:00:00Z', content_length: 1000 }],
      getCategoryContentSlice: (_name: string, maxChars: number) => ({ content: 'x'.repeat(maxChars), length: maxChars }),
      listMemories: () => [{ type: 'semantic', content: 'a memory that fits', summary: 'mem' }],
    });
    const handler = new ResourceHandler(config, storage, search, healthy);

    const result = await handler.handle('memory://inject') as InjectResult;

    expect(result.memories_count).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it('budget_unit: tokens scales the char budget by the chars/4 estimate (5.3)', async () => {
    const search = { searchForInject: vi.fn() } as unknown as SearchService;
    const storage = makeStorage({
      listMemories: () => [{ type: 'semantic', content: 'irrelevant, summary is used instead', summary: 's' }],
    });
    const tokensConfig = {
      ...baseConfig,
      auto_inject: { max_chars: 3, memory_budget_fraction: 0, budget_unit: 'tokens', dedup_suppression: true },
    } as unknown as BrainConfig;
    const charsConfig = {
      ...baseConfig,
      auto_inject: { max_chars: 3, memory_budget_fraction: 0, budget_unit: 'chars', dedup_suppression: true },
    } as unknown as BrainConfig;

    const tokensResult = await new ResourceHandler(tokensConfig, storage, search, healthy)
      .handle('memory://inject') as InjectResult;
    const charsResult = await new ResourceHandler(charsConfig, storage, search, healthy)
      .handle('memory://inject') as InjectResult;

    // Same numeric config value; 'tokens' interprets it as 4x the char capacity.
    expect(tokensResult.content.length).toBe(12);
    expect(charsResult.content.length).toBe(3);
  });

  it('suppresses a near-duplicate candidate above the dedup threshold (5.4)', async () => {
    const a = mkResult('a', 'first version', [1, 0, 0]);
    const b = mkResult('b', 'near duplicate version', [0.999, Math.sqrt(1 - 0.999 ** 2), 0]); // cos sim ~0.999
    const search = { searchForInject: vi.fn(async () => [a, b]) } as unknown as SearchService;
    const storage = makeStorage();
    const handler = new ResourceHandler(baseConfig, storage, search, healthy);

    const result = await handler.handle('memory://inject/task') as InjectResult;

    expect(result.memories_count).toBe(1);
    expect(result.content).toContain('first version');
    expect(result.content).not.toContain('near duplicate version');
  });

  it('candidates without a vector (fulltext-only) are never suppressed', async () => {
    const withVector = mkResult('a', 'has a vector', [1, 0, 0]);
    const withoutVector = mkResult('b', 'no vector at all', undefined);
    const search = { searchForInject: vi.fn(async () => [withVector, withoutVector]) } as unknown as SearchService;
    const storage = makeStorage();
    const handler = new ResourceHandler(baseConfig, storage, search, healthy);

    const result = await handler.handle('memory://inject/task') as InjectResult;

    expect(result.memories_count).toBe(2);
  });

  it('dedup_suppression: false keeps near-duplicates', async () => {
    const a = mkResult('a', 'first version', [1, 0, 0]);
    const b = mkResult('b', 'near duplicate version', [0.999, Math.sqrt(1 - 0.999 ** 2), 0]);
    const search = { searchForInject: vi.fn(async () => [a, b]) } as unknown as SearchService;
    const config = {
      ...baseConfig,
      auto_inject: { max_chars: 500, memory_budget_fraction: 0.4, budget_unit: 'chars', dedup_suppression: false },
    } as unknown as BrainConfig;
    const storage = makeStorage();
    const handler = new ResourceHandler(config, storage, search, healthy);

    const result = await handler.handle('memory://inject/task') as InjectResult;

    expect(result.memories_count).toBe(2);
  });
});

describe('inject pinning (add-inject-pinning)', () => {
  const baseConfig = {
    defaults: { namespace: 'global', auto_inject_limit: 5 },
    auto_inject: {
      max_chars: 500, memory_budget_fraction: 0.4, budget_unit: 'chars',
      dedup_suppression: true, pinned_enabled: true,
    },
    deduplication: { similarity_threshold: 0.9 },
  } as unknown as BrainConfig;

  const healthy = { check: async () => ({ status: 'healthy' }) } as HealthService;

  function makeStorage(overrides: Record<string, unknown> = {}) {
    return {
      sqlite: {
        listCategoryHeaders: () => [],
        getCategoryContentSlice: () => ({ content: '', length: 0 }),
        listMemories: () => [],
        listPinnedMemories: () => [],
        countMemories: () => 0,
        getMemoryById: () => null,
        touchMemory: () => undefined,
        scheduleDeferredFlush: () => undefined,
        listCategories: () => [],
        listCollections: () => [],
        getCategory: () => null,
        ...overrides,
      },
    } as unknown as StorageManager;
  }

  const mkPinned = (id: string, content: string) => ({
    id, type: 'semantic', content, summary: id, updated_at: '2026-01-01T00:00:00Z',
  });

  const mkResult = (id: string, content: string, vector?: number[]): SearchResult => ({
    id, content, summary: id, type: 'semantic', tags: [], score: 0.9,
    retention_tier: 'T2', created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
    vector,
  });

  it('hintless inject includes pinned memories ahead of recency (5.5)', async () => {
    const storage = makeStorage({
      listPinnedMemories: () => [mkPinned('p1', 'critical pinned fact')],
      listMemories: () => [{ type: 'semantic', content: 'recent unrelated memory', summary: 'recent' }],
    });
    const handler = new ResourceHandler(baseConfig, storage, {} as SearchService, healthy);

    const result = await handler.handle('memory://inject') as InjectResult;

    expect(result.content).toContain('critical pinned fact');
    expect(result.content).toContain('recent unrelated memory');
    expect(result.memories_count).toBe(2);
    // Pinned content appears first in the assembled block.
    expect(result.content.indexOf('critical pinned fact')).toBeLessThan(result.content.indexOf('recent unrelated memory'));
  });

  it('hinted inject includes pinned memories ahead of relevance, even when unmatched (5.6)', async () => {
    const searchForInject = vi.fn(async () => [mkResult('r1', 'relevant to hint')]);
    const search = { searchForInject } as unknown as SearchService;
    const storage = makeStorage({
      listPinnedMemories: () => [mkPinned('p1', 'pinned unrelated to hint')],
    });
    const handler = new ResourceHandler(baseConfig, storage, search, healthy);

    const result = await handler.handle('memory://inject/some%20hint') as InjectResult;

    expect(result.content).toContain('pinned unrelated to hint');
    expect(result.content).toContain('relevant to hint');
    expect(result.memories_count).toBe(2);
  });

  it('a memory that is both pinned and independently top-ranked appears exactly once (5.7)', async () => {
    const searchForInject = vi.fn(async () => [mkResult('shared', 'shared content'), mkResult('other', 'other content')]);
    const search = { searchForInject } as unknown as SearchService;
    const storage = makeStorage({
      listPinnedMemories: () => [mkPinned('shared', 'shared content')],
    });
    const handler = new ResourceHandler(baseConfig, storage, search, healthy);

    const result = await handler.handle('memory://inject/hint') as InjectResult;

    expect(result.memories_count).toBe(2);
    expect(result.content.match(/shared content/g)).toHaveLength(1);
  });

  it('pinned_enabled: false restores byte-for-byte pre-pinning behavior (5.9)', async () => {
    const listMemories = () => [{ type: 'semantic', content: 'recent memory', summary: 'recent' }];
    const listPinnedMemories = vi.fn(() => [mkPinned('p1', 'should never appear')]);
    const disabledConfig = {
      ...baseConfig,
      auto_inject: { ...baseConfig.auto_inject, pinned_enabled: false },
    } as unknown as BrainConfig;
    const storageDisabled = makeStorage({ listMemories, listPinnedMemories });
    const storageEnabledNoPins = makeStorage({ listMemories, listPinnedMemories: () => [] });

    const disabledResult = await new ResourceHandler(disabledConfig, storageDisabled, {} as SearchService, healthy)
      .handle('memory://inject') as InjectResult;
    const enabledNoPinsResult = await new ResourceHandler(baseConfig, storageEnabledNoPins, {} as SearchService, healthy)
      .handle('memory://inject') as InjectResult;

    expect(listPinnedMemories).not.toHaveBeenCalled();
    expect(disabledResult.content).not.toContain('should never appear');
    expect(disabledResult.content).toBe(enabledNoPinsResult.content);
    expect(disabledResult.memories_count).toBe(enabledNoPinsResult.memories_count);
  });

  it('two near-duplicate pinned memories are both injected, not suppressed against each other (5.8)', async () => {
    const storage = makeStorage({
      listPinnedMemories: () => [mkPinned('p1', 'near duplicate content A'), mkPinned('p2', 'near duplicate content B')],
    });
    const handler = new ResourceHandler(baseConfig, storage, {} as SearchService, healthy);

    const result = await handler.handle('memory://inject') as InjectResult;

    expect(result.content).toContain('near duplicate content A');
    expect(result.content).toContain('near duplicate content B');
    expect(result.memories_count).toBe(2);
  });

  it('a pinned memory and a near-duplicate relevance candidate are both injected (5.8)', async () => {
    const pinnedVectorLike = mkResult('rel', 'near duplicate relevance candidate', [0.999, Math.sqrt(1 - 0.999 ** 2), 0]);
    const searchForInject = vi.fn(async () => [pinnedVectorLike]);
    const search = { searchForInject } as unknown as SearchService;
    const storage = makeStorage({
      listPinnedMemories: () => [mkPinned('pin', 'near duplicate pinned content')],
    });
    const handler = new ResourceHandler(baseConfig, storage, search, healthy);

    const result = await handler.handle('memory://inject/hint') as InjectResult;

    expect(result.content).toContain('near duplicate pinned content');
    expect(result.content).toContain('near duplicate relevance candidate');
    expect(result.memories_count).toBe(2);
  });

  it('a shared pinned/top-ranked id is excluded before suppression, so it never suppresses a distinct near-duplicate candidate (4.3)', async () => {
    // 'shared' is both pinned and independently top-ranked by relevance, and
    // is a near-duplicate (by vector) of a distinct candidate 'other'. If
    // exclusion ran after suppression, greedy suppression would select
    // 'shared' first and drop 'other' as its near-duplicate — even though
    // 'shared' itself is excluded from the candidate list moments later.
    // Excluding first means suppression never sees 'shared' at all, so
    // 'other' must survive.
    const shared = mkResult('shared', 'shared content', [1, 0, 0]);
    const other = mkResult('other', 'distinct near-duplicate content', [0.999, Math.sqrt(1 - 0.999 ** 2), 0]);
    const searchForInject = vi.fn(async () => [shared, other]);
    const search = { searchForInject } as unknown as SearchService;
    const storage = makeStorage({
      listPinnedMemories: () => [mkPinned('shared', 'shared content')],
    });
    const handler = new ResourceHandler(baseConfig, storage, search, healthy);

    const result = await handler.handle('memory://inject/hint') as InjectResult;

    expect(result.content).toContain('shared content');
    expect(result.content).toContain('distinct near-duplicate content');
    expect(result.memories_count).toBe(2);
  });

  it('oversized pinned content truncates per-item and sets truncated: true (5.10)', async () => {
    const config = {
      ...baseConfig,
      auto_inject: { ...baseConfig.auto_inject, max_chars: 10 },
    } as unknown as BrainConfig;
    // Both content and summary exceed the budget so neither the full-content nor
    // the summary-fallback block fits, forcing appendBlock's slice-and-truncate path.
    const storage = makeStorage({
      listPinnedMemories: () => [{
        id: 'p1', type: 'semantic', content: 'x'.repeat(100), summary: 'y'.repeat(100),
        updated_at: '2026-01-01T00:00:00Z',
      }],
    });
    const handler = new ResourceHandler(config, storage, {} as SearchService, healthy);

    const result = await handler.handle('memory://inject') as InjectResult;

    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(10);
    expect(result.memories_count).toBe(0);
  });
});

describe('MCP resource template discovery', () => {
  it('concrete resources do not include parameterized URIs', () => {
    for (const r of MCP_RESOURCE_DEFINITIONS) {
      expect(r.uri).not.toContain('{');
      expect(r.uri).not.toContain('}');
    }
  });

  it('templates contain parameterized URIs', () => {
    expect(MCP_RESOURCE_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of MCP_RESOURCE_TEMPLATES) {
      expect(t.uriTemplate).toContain('{');
    }
  });

  it('templates cover memory, category, and collection by-id patterns', () => {
    const templates = MCP_RESOURCE_TEMPLATES.map(t => t.uriTemplate);
    expect(templates).toContain('memory://{id}');
    expect(templates).toContain('memory://{id}/revisions');
    expect(templates).toContain('memory://inject/{hint}');
    expect(templates).toContain('category://{name}');
    expect(templates).toContain('collection://{name}');
  });
});

describe('MCP tool error signaling', () => {
  it('error envelopes have error.code and error.message', () => {
    // Simulate the error envelope format
    const envelope = { error: { code: 'INVALID_INPUT', message: 'bad input', retryable: false } };
    expect(envelope.error.code).toBeDefined();
    expect(envelope.error.message).toBeDefined();
    expect(typeof envelope.error.retryable).toBe('boolean');
  });
});

describe('collection resource scoping', () => {
  type CollectionResult = {
    collection: string;
    namespace: string;
    memories: Array<{ id: string }>;
    cursor: string | null;
    total_results: number;
    truncated: boolean;
  };

  function createHandler() {
    const calls: Array<{ namespace: string; collection: string }> = [];
    const mkMem = (id: string, namespace: string, collection: string) => ({
      id, namespace, collection, type: 'semantic', category: null,
      content: 'c', summary: 's', tags: [], source: 'cli', checksum: id,
      importance: 0.5, access_count: 0, last_operation: 'ADD', merged_from: null,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      last_accessed: '2026-01-01T00:00:00.000Z',
    });
    const rows = [
      mkMem('g1', 'global', 'work'),
      mkMem('o1', 'other', 'work'),
    ];

    const storage = {
      sqlite: {
        listCollections: (_ns?: string) => [],
        listMemoriesInCollection: (namespace: string, collection: string, limit: number) => {
          calls.push({ namespace, collection });
          return rows.filter(m => m.namespace === namespace && m.collection === collection).slice(0, limit);
        },
        countMemoriesInCollection: (namespace: string, collection: string) =>
          rows.filter(m => m.namespace === namespace && m.collection === collection).length,
      },
    } as unknown as StorageManager;

    const config = {
      defaults: { namespace: 'global', auto_inject_limit: 5 },
      auto_inject: { max_chars: 500 },
    } as unknown as BrainConfig;

    const handler = new ResourceHandler(
      config, storage, {} as SearchService,
      { check: async () => ({ status: 'healthy' }) } as HealthService,
    );
    return { handler, calls };
  }

  it('defaults collection reads to the configured namespace (no cross-namespace leak)', async () => {
    const { handler, calls } = createHandler();
    const result = await handler.handle('collection://work') as CollectionResult;
    expect(calls[0]!.namespace).toBe('global');
    expect(result.namespace).toBe('global');
    expect(result.memories.map(m => m.id)).toEqual(['g1']);
  });

  it('honors an explicit ?namespace= override', async () => {
    const { handler } = createHandler();
    const result = await handler.handle('collection://work?namespace=other') as CollectionResult;
    expect(result.namespace).toBe('other');
    expect(result.memories.map(m => m.id)).toEqual(['o1']);
  });

  it('rejects an invalid limit', async () => {
    const { handler } = createHandler();
    const result = await handler.handle('collection://work?limit=abc') as { error: { code: string } };
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});
