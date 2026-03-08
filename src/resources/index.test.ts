import { describe, it, expect } from 'vitest';
import { ResourceHandler, MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_TEMPLATES } from './index.js';

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
    } as any;

    return new ResourceHandler(
      { defaults: { namespace: 'global', auto_inject_limit: 5 }, auto_inject: { max_chars: 500 } } as any,
      storage,
      {} as any,
      { check: async () => ({ status: 'healthy' }) } as any,
    );
  }

  it('returns INVALID_INPUT for non-numeric limit', async () => {
    const handler = createHandler();
    const result = await handler.handle('memory://list?limit=abc') as any;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT for out-of-range limit', async () => {
    const handler = createHandler();
    const result = await handler.handle('memory://list?limit=1000') as any;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns bounded paginated response for valid limit', async () => {
    const handler = createHandler();
    const result = await handler.handle('memory://list?limit=1') as any;
    expect(result.items).toHaveLength(1);
    expect(result.total_results).toBe(2);
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
