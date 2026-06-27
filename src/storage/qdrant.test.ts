import { describe, it, expect, vi } from 'vitest';
import { QdrantStore } from './qdrant.js';
import type { BrainConfig } from '../config/index.js';

type MockClient = {
  getCollections: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
};

function createStore(client: MockClient): QdrantStore {
  const config = {
    embedding: { dimensions: 3 },
    qdrant: { mode: 'embedded' },
  } as unknown as BrainConfig;
  const store = new QdrantStore(config);
  // Inject the mock transport (no breaker -> executeWithBreaker calls through).
  (store as unknown as { client: MockClient }).client = client;
  return store;
}

describe('QdrantStore.search collection fan-out', () => {
  it('searches every collection in the namespace when none is specified', async () => {
    const client: MockClient = {
      getCollections: vi.fn(async () => ({
        collections: [
          { name: 'bhgbrain_global_work' },
          { name: 'bhgbrain_global_general' },
          { name: 'bhgbrain_other_work' }, // different namespace — must be skipped
        ],
      })),
      search: vi.fn(async (name: string) => {
        if (name === 'bhgbrain_global_work') return [{ id: 'w1', score: 0.9, payload: { namespace: 'global' } }];
        if (name === 'bhgbrain_global_general') return [{ id: 'g1', score: 0.8, payload: { namespace: 'global' } }];
        return [{ id: 'other', score: 0.99, payload: { namespace: 'other' } }];
      }),
    };
    const store = createStore(client);

    const results = await store.search('global', undefined, [1, 2, 3], 10);

    // Both global collections searched, the foreign-namespace one untouched.
    const searched = client.search.mock.calls.map(c => c[0]);
    expect(searched).toEqual(expect.arrayContaining(['bhgbrain_global_work', 'bhgbrain_global_general']));
    expect(searched).not.toContain('bhgbrain_other_work');
    // Merged + sorted by score, no silent `general`-only fallback.
    expect(results.map(r => r.id)).toEqual(['w1', 'g1']);
  });

  it('returns empty without querying when the namespace has no collections', async () => {
    const client: MockClient = {
      getCollections: vi.fn(async () => ({ collections: [{ name: 'bhgbrain_other_work' }] })),
      search: vi.fn(),
    };
    const store = createStore(client);
    const results = await store.search('global', undefined, [1, 2, 3], 10);
    expect(results).toEqual([]);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('searches only the named collection when one is specified', async () => {
    const client: MockClient = {
      getCollections: vi.fn(),
      search: vi.fn(async () => [{ id: 'w1', score: 0.9, payload: { namespace: 'global' } }]),
    };
    const store = createStore(client);
    const results = await store.search('global', 'work', [1, 2, 3], 10);
    expect(client.getCollections).not.toHaveBeenCalled();
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search.mock.calls[0]![0]).toBe('bhgbrain_global_work');
    expect(results.map(r => r.id)).toEqual(['w1']);
  });
});
