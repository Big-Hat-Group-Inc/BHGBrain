import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { QdrantStore } from './qdrant.js';
import type { BrainConfig } from '../config/index.js';
import type { QdrantClient } from '@qdrant/js-client-rest';

// Bound to the real client's method signatures (rather than an independently
// declared structural shape) so that an upstream removal or signature change
// of `getCollections`/`query` fails `npm run lint` instead of leaving this
// suite green against a client the adapter can no longer actually call.
type MockClient = {
  getCollections: Mock<QdrantClient['getCollections']>;
  query: Mock<QdrantClient['query']>;
};

function createStore(client: MockClient): QdrantStore {
  const config = {
    embedding: { dimensions: 3 },
    qdrant: { mode: 'embedded' },
    defaults: { namespace: 'global', collection: 'general' },
  } as unknown as BrainConfig;
  const store = new QdrantStore(config);
  // Inject the mock transport (no breaker -> executeWithBreaker calls through).
  (store as unknown as { client: MockClient }).client = client;
  return store;
}

describe('QdrantStore.search collection fan-out', () => {
  it('searches every collection in the namespace when none is specified', async () => {
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(async () => ({
        collections: [
          { name: 'bhgbrain_global_work' },
          { name: 'bhgbrain_global_general' },
          { name: 'bhgbrain_other_work' }, // different namespace — must be skipped
        ],
      })),
      query: vi.fn<QdrantClient['query']>(async (name: string) => {
        if (name === 'bhgbrain_global_work') {
          return { points: [{ id: 'w1', score: 0.9, version: 0, payload: { namespace: 'global' } }] };
        }
        if (name === 'bhgbrain_global_general') {
          return { points: [{ id: 'g1', score: 0.8, version: 0, payload: { namespace: 'global' } }] };
        }
        return { points: [{ id: 'other', score: 0.99, version: 0, payload: { namespace: 'other' } }] };
      }),
    };
    const store = createStore(client);

    const results = await store.search('global', undefined, [1, 2, 3], 10);

    // Both global collections searched, the foreign-namespace one untouched.
    const searched = client.query.mock.calls.map(c => c[0]);
    expect(searched).toEqual(expect.arrayContaining(['bhgbrain_global_work', 'bhgbrain_global_general']));
    expect(searched).not.toContain('bhgbrain_other_work');
    // Merged + sorted by score, no silent `general`-only fallback.
    expect(results.map(r => r.id)).toEqual(['w1', 'g1']);
  });

  it('returns empty without querying when the namespace has no collections', async () => {
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(async () => ({ collections: [{ name: 'bhgbrain_other_work' }] })),
      query: vi.fn<QdrantClient['query']>(),
    };
    const store = createStore(client);
    const results = await store.search('global', undefined, [1, 2, 3], 10);
    expect(results).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('searches only the named collection when one is specified', async () => {
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(),
      query: vi.fn<QdrantClient['query']>(async () => ({
        points: [{ id: 'w1', score: 0.9, version: 0, payload: { namespace: 'global' } }],
      })),
    };
    const store = createStore(client);
    const results = await store.search('global', 'work', [1, 2, 3], 10);
    expect(client.getCollections).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0]![0]).toBe('bhgbrain_global_work');
    expect(results.map(r => r.id)).toEqual(['w1']);
  });

  it('unwraps response.points into mapped id/score/payload results', async () => {
    // Regression guard: if the adapter forgot to unwrap `response.points` and
    // instead mapped over the raw `{ points: [...] }` response object, this
    // would silently degrade to an empty/undefined-id result instead of
    // throwing, which is exactly the failure mode this change closes.
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(),
      query: vi.fn<QdrantClient['query']>(async () => ({
        points: [{ id: 'w1', score: 0.9, version: 0, payload: { namespace: 'global' } }],
      })),
    };
    const store = createStore(client);
    const results = await store.search('global', 'work', [1, 2, 3], 10);
    expect(results).toEqual([{ id: 'w1', score: 0.9, payload: { namespace: 'global' } }]);
  });
});

describe('QdrantStore.searchSimilar', () => {
  it('returns mapped results from a populated query response', async () => {
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(),
      query: vi.fn<QdrantClient['query']>(async () => ({
        points: [{ id: 'dup-1', score: 0.95, version: 0 }],
      })),
    };
    const store = createStore(client);
    const results = await store.searchSimilar('global', 'work', [1, 2, 3], 10);
    expect(results).toEqual([{ id: 'dup-1', score: 0.95 }]);
  });

  it('reports a genuinely empty result as no similar vectors', async () => {
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(),
      query: vi.fn<QdrantClient['query']>(async () => ({ points: [] })),
    };
    const store = createStore(client);
    const results = await store.searchSimilar('global', 'work', [1, 2, 3], 10);
    expect(results).toEqual([]);
  });

  it('treats a missing collection as no similar vectors', async () => {
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(),
      query: vi.fn<QdrantClient['query']>(async () => {
        const err = new Error('Collection `bhgbrain_global_work` doesn\'t exist!') as Error & { status?: number };
        err.status = 404;
        throw err;
      }),
    };
    const store = createStore(client);
    const results = await store.searchSimilar('global', 'work', [1, 2, 3], 10);
    expect(results).toEqual([]);
  });

  it('propagates a client failure instead of reporting no similar vectors', async () => {
    // A transport failure, auth failure, or a removed client method must not
    // be swallowed into "no near duplicates" — the write pipeline needs to
    // see this as a failed similarity check, not a novel write.
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(),
      query: vi.fn<QdrantClient['query']>(async () => {
        throw new TypeError('this.client.query is not a function');
      }),
    };
    const store = createStore(client);
    await expect(store.searchSimilar('global', 'work', [1, 2, 3], 10)).rejects.toThrow(
      'this.client.query is not a function',
    );
  });
});

describe('QdrantStore.healthCheck', () => {
  // Regression guard for the 1.19 outage: the server was reachable
  // (`getCollections` succeeded) but every retrieval call threw. A probe
  // that only checks connectivity cannot detect this.
  it('reports unhealthy when the retrieval call throws even though the store is reachable', async () => {
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(async () => ({ collections: [] })),
      query: vi.fn<QdrantClient['query']>(async () => {
        throw new TypeError('this.client.query is not a function');
      }),
    };
    const store = createStore(client);

    await expect(store.healthCheck()).rejects.toThrow('this.client.query is not a function');
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('reports healthy on a successful probe that returns zero results', async () => {
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(),
      query: vi.fn<QdrantClient['query']>(async () => ({ points: [] })),
    };
    const store = createStore(client);

    await expect(store.healthCheck()).resolves.toBe(true);
    // Bounded and side-effect free: a minimal limit, no payload hydration.
    const call = client.query.mock.calls[0]![1] as { limit: number; with_payload: boolean };
    expect(call.limit).toBe(1);
    expect(call.with_payload).toBe(false);
  });

  it('reports healthy when the probed collection does not exist yet', async () => {
    const client: MockClient = {
      getCollections: vi.fn<QdrantClient['getCollections']>(),
      query: vi.fn<QdrantClient['query']>(async () => {
        const err = new Error('Collection `bhgbrain_global_general` doesn\'t exist!') as Error & { status?: number };
        err.status = 404;
        throw err;
      }),
    };
    const store = createStore(client);

    await expect(store.healthCheck()).resolves.toBe(true);
  });
});
