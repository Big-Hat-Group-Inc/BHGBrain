import { describe, it, expect } from 'vitest';
import { FakeQdrantClient } from './fake-qdrant-client.js';

describe('FakeQdrantClient', () => {
  it('returns the closest point first on upsert-then-query', async () => {
    const client = new FakeQdrantClient();
    await client.createCollection('c1');
    await client.upsert('c1', {
      points: [
        { id: 'a', vector: [1, 0, 0], payload: { namespace: 'global' } },
        { id: 'b', vector: [0, 1, 0], payload: { namespace: 'global' } },
        { id: 'c', vector: [0.9, 0.1, 0], payload: { namespace: 'global' } },
      ],
    });

    const result = await client.query('c1', { query: [1, 0, 0], limit: 10, with_payload: true });

    expect(result.points[0]!.id).toBe('a');
    expect(result.points.map(p => p.id)).toEqual(['a', 'c', 'b']);
  });

  it('excludes points that do not match a type filter clause', async () => {
    const client = new FakeQdrantClient();
    await client.createCollection('c1');
    await client.upsert('c1', {
      points: [
        { id: 'sem', vector: [1, 0], payload: { type: 'semantic' } },
        { id: 'proc', vector: [1, 0], payload: { type: 'procedural' } },
      ],
    });

    const result = await client.query('c1', {
      query: [1, 0],
      limit: 10,
      filter: { must: [{ key: 'type', match: { value: 'semantic' } }] },
    });

    expect(result.points.map(p => p.id)).toEqual(['sem']);
  });

  it('excludes points that match none of a tags match-any filter clause', async () => {
    const client = new FakeQdrantClient();
    await client.createCollection('c1');
    await client.upsert('c1', {
      points: [
        { id: 'billing', vector: [1, 0], payload: { tags: ['billing', 'urgent'] } },
        { id: 'infra', vector: [1, 0], payload: { tags: ['infra'] } },
      ],
    });

    const result = await client.query('c1', {
      query: [1, 0],
      limit: 10,
      filter: { must: [{ key: 'tags', match: { any: ['urgent', 'security'] } }] },
    });

    expect(result.points.map(p => p.id)).toEqual(['billing']);
  });

  it('throws a 404-shaped error when querying a collection that was never created', async () => {
    const client = new FakeQdrantClient();
    await expect(client.query('missing', { query: [1, 0], limit: 10 })).rejects.toMatchObject({ status: 404 });
  });

  it('omits payload and vector from results unless explicitly requested', async () => {
    const client = new FakeQdrantClient();
    await client.createCollection('c1');
    await client.upsert('c1', { points: [{ id: 'a', vector: [1, 0], payload: { foo: 'bar' } }] });

    const bare = await client.query('c1', { query: [1, 0], limit: 10 });
    expect(bare.points[0]!.payload).toBeUndefined();
    expect(bare.points[0]!.vector).toBeUndefined();

    const full = await client.query('c1', { query: [1, 0], limit: 10, with_payload: true, with_vector: true });
    expect(full.points[0]!.payload).toEqual({ foo: 'bar' });
    expect(full.points[0]!.vector).toEqual([1, 0]);
  });
});
