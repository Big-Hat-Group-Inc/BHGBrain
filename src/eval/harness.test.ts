import { describe, it, expect, afterEach } from 'vitest';
import {
  createEvalStorage,
  seedCorpusEntries,
  seedFixtureStore,
  runGoldenSet,
  scoreResults,
  teardownEvalStorage,
  type EvalStorage,
} from './harness.js';
import type { CorpusFixtureEntry, GoldenSetEntry } from './fixtures.js';

const stores: EvalStorage[] = [];

afterEach(() => {
  while (stores.length > 0) {
    teardownEvalStorage(stores.pop()!);
  }
});

function track(store: EvalStorage): EvalStorage {
  stores.push(store);
  return store;
}

describe('seedFixtureStore', () => {
  it('populates the expected number of rows in both the SQLite and fake Qdrant stores', async () => {
    const seeded = track(await seedFixtureStore());
    expect(seeded.corpusSize).toBeGreaterThan(0);
    expect(seeded.storage.sqlite.countMemories('global')).toBe(seeded.corpusSize);
    expect(seeded.qdrantClient.totalPointCount()).toBe(seeded.corpusSize);
  });
});

describe('runGoldenSet against the full fixture corpus', () => {
  it('ranks an unambiguous golden-set query\'s expected memory first', async () => {
    const seeded = track(await seedFixtureStore());
    // golden-039 targets an episodic architecture-decision memory
    // ("did we decide to split billing into its own microservice") whose
    // vocabulary (billing, microservice, split, decision) is distinctive
    // enough within the fixture corpus not to be contested by a
    // near-duplicate same-topic distractor, unlike e.g. the two
    // deliberately-close TypeScript-generics anchors.
    const entry: GoldenSetEntry = {
      id: 'golden-039',
      query: 'did we decide to split billing into its own microservice',
      expected_corpus_id: 'corpus-0134',
    };
    const [result] = await runGoldenSet(seeded.storage, seeded.config, [entry]);
    expect(result!.rank).toBe(1);
  });
});

describe('runGoldenSet + scoreResults on a small synthetic fixture', () => {
  const corpus: CorpusFixtureEntry[] = [
    {
      id: 'synth-1', namespace: 'global', collection: 'general', type: 'semantic', category: null,
      content: 'The quarterly budget review happens every March and September for finance planning.',
      summary: 'Quarterly budget review schedule', tags: ['finance'], source: 'cli', importance: 0.6,
    },
    {
      id: 'synth-2', namespace: 'global', collection: 'general', type: 'semantic', category: null,
      content: 'Backend deploys use a blue-green rollout strategy to avoid downtime during release.',
      summary: 'Blue-green deploy strategy', tags: ['deploy'], source: 'cli', importance: 0.6,
    },
    {
      id: 'synth-3', namespace: 'global', collection: 'general', type: 'semantic', category: null,
      content: 'Espresso machines in the office kitchen are serviced monthly by the facilities vendor.',
      summary: 'Espresso machine servicing schedule', tags: ['facilities'], source: 'cli', importance: 0.3,
    },
  ];

  const goldenSet: GoldenSetEntry[] = [
    { id: 'g1', query: 'when is the quarterly budget review for finance', expected_corpus_id: 'synth-1' },
    { id: 'g2', query: 'what rollout strategy do backend deploys use', expected_corpus_id: 'synth-2' },
    // Deliberately unanswerable: no synthetic entry discusses payroll, so
    // this query's expected id is intentionally absent from the corpus,
    // producing a hand-verifiable miss (rank null, contributes 0 everywhere).
    { id: 'g3', query: 'how often is payroll processed', expected_corpus_id: 'does-not-exist' },
  ];

  async function seedSynthetic(): Promise<EvalStorage> {
    const store = track(await createEvalStorage());
    await seedCorpusEntries(store.storage, corpus);
    return store;
  }

  it('produces hand-verifiable per-query ranks and aggregate recall/MRR', async () => {
    const store = await seedSynthetic();
    const ranks = await runGoldenSet(store.storage, store.config, goldenSet);
    const { perQuery, aggregate } = scoreResults(ranks);

    const g1 = perQuery.find(q => q.query_id === 'g1')!;
    const g2 = perQuery.find(q => q.query_id === 'g2')!;
    const g3 = perQuery.find(q => q.query_id === 'g3')!;

    expect(g1.rank).toBe(1);
    expect(g1.recall_at_1).toBe(1);
    expect(g1.reciprocal_rank).toBe(1);

    expect(g2.rank).toBe(1);
    expect(g2.recall_at_1).toBe(1);

    expect(g3.rank).toBeNull();
    expect(g3.recall_at_1).toBe(0);
    expect(g3.recall_at_5).toBe(0);
    expect(g3.recall_at_10).toBe(0);
    expect(g3.reciprocal_rank).toBe(0);

    // Two hits at rank 1 and one clean miss out of three queries.
    expect(aggregate.count).toBe(3);
    expect(aggregate.recall1).toBeCloseTo(2 / 3, 6);
    expect(aggregate.recall5).toBeCloseTo(2 / 3, 6);
    expect(aggregate.mrr10).toBeCloseTo(2 / 3, 6);
  });

  it('is deterministic: two consecutive runs against the same fixtures produce identical metrics', async () => {
    const storeA = await seedSynthetic();
    const resultA = scoreResults(await runGoldenSet(storeA.storage, storeA.config, goldenSet));

    const storeB = await seedSynthetic();
    const resultB = scoreResults(await runGoldenSet(storeB.storage, storeB.config, goldenSet));

    expect(resultA.aggregate).toEqual(resultB.aggregate);
    expect(resultA.perQuery.map(q => q.rank)).toEqual(resultB.perQuery.map(q => q.rank));
  });
});
