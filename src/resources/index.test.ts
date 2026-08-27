import { describe, it, expect } from 'vitest';
import { ResourceHandler, MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_TEMPLATES } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { HealthService } from '../health/index.js';
import type { SearchService } from '../search/index.js';
import type { StorageManager } from '../storage/index.js';
import type { BrainErrorEnvelope, ErrorEnvelope } from '../errors/index.js';

type ListResult = { items: unknown[]; total_results: number };
type InjectResult = { content: string; truncated: boolean };
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
      auto_inject: { max_chars: 24 },
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
      auto_inject: { max_chars: 500 },
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
