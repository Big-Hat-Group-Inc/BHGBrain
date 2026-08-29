import { describe, it, expect, beforeAll } from 'vitest';
import { seedFixtureStore, runGoldenSet, scoreResults, teardownEvalStorage, type EvalStorage, type ScoredGoldenSet } from './harness.js';

// Measured baseline at authoring time (2026-08-29), full 175-entry corpus /
// 50-entry golden set, production `SearchService.search` in hybrid mode
// against the `FixtureEmbeddingProvider`: recall@1 0.84, recall@5 1.00,
// recall@10 1.00, MRR@10 0.9133. Floors sit below that measured baseline —
// not equal to it — so incidental noise (e.g. a future golden-set/corpus
// edit) doesn't trip the gate; a genuine retrieval regression (composite
// ranking, RRF fusion, filter push-down, or the fulltext matcher getting
// worse) still fails it. Update these deliberately, in the same PR as the
// retrieval change that legitimately moves them (design.md Risks/Trade-offs
// "Threshold floors will need occasional deliberate updates").
export const FLOOR_RECALL_5 = 0.9;
export const FLOOR_MRR_10 = 0.8;

let scored: ScoredGoldenSet;
let seeded: EvalStorage;

beforeAll(async () => {
  seeded = await seedFixtureStore();
  const ranks = await runGoldenSet(seeded.storage, seeded.config);
  scored = scoreResults(ranks);

  // Deliberate: a floor-trip failure's CI output should show every query's
  // rank, not just the aggregate number.
  console.table(scored.perQuery.map(q => ({
    query_id: q.query_id,
    rank: q.rank ?? 'not found',
    expected: q.expected_corpus_id,
    'recall@1': q.recall_at_1,
    'recall@5': q.recall_at_5,
    'recall@10': q.recall_at_10,
    rr: q.reciprocal_rank.toFixed(3),
  })));
  console.log('aggregate', scored.aggregate);

  return () => {
    teardownEvalStorage(seeded);
  };
});

describe('golden-set retrieval-quality gate', () => {
  it('aggregate recall@5 and MRR@10 meet their checked-in floors', () => {
    expect(scored.aggregate.recall5).toBeGreaterThanOrEqual(FLOOR_RECALL_5);
    expect(scored.aggregate.mrr10).toBeGreaterThanOrEqual(FLOOR_MRR_10);
  });

  it('ran the full checked-in golden set (not a truncated subset)', () => {
    expect(scored.aggregate.count).toBeGreaterThanOrEqual(50);
  });
});
