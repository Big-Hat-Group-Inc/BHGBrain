#!/usr/bin/env tsx
// Standalone CLI entry point for local golden-set iteration: `npm run eval`.
// Runs the same `seedFixtureStore`/`runGoldenSet`/`scoreResults` core the
// `src/eval/golden-set.test.ts` Vitest gate uses — one implementation of
// "seed store, run queries, score", this script only pretty-prints it (see
// design.md "npm run eval is a thin CLI over the same harness core").
import { seedFixtureStore, runGoldenSet, scoreResults, teardownEvalStorage } from './harness.js';

async function main(): Promise<void> {
  const seeded = await seedFixtureStore();
  try {
    const ranks = await runGoldenSet(seeded.storage, seeded.config);
    const { perQuery, aggregate } = scoreResults(ranks);

    console.log(`Golden-set eval: ${aggregate.count} queries against a ${seeded.corpusSize}-entry corpus\n`);
    console.table(perQuery.map(q => ({
      query_id: q.query_id,
      query: q.query.length > 60 ? `${q.query.slice(0, 57)}...` : q.query,
      rank: q.rank ?? 'not found',
      'recall@1': q.recall_at_1,
      'recall@5': q.recall_at_5,
      'recall@10': q.recall_at_10,
      rr: q.reciprocal_rank.toFixed(3),
    })));

    console.log('\nAggregate:');
    console.log(`  recall@1  = ${aggregate.recall1.toFixed(4)}`);
    console.log(`  recall@5  = ${aggregate.recall5.toFixed(4)}`);
    console.log(`  recall@10 = ${aggregate.recall10.toFixed(4)}`);
    console.log(`  MRR@10    = ${aggregate.mrr10.toFixed(4)}`);
  } finally {
    teardownEvalStorage(seeded);
  }
}

main().catch(err => {
  // Non-zero exit on any error running the queries themselves (store/
  // embedding failure), independent of whether the recall/MRR metrics meet
  // their floors — that gate is `golden-set.test.ts`'s job, not this
  // script's (spec.md "it SHALL exit non-zero if any query errors,
  // independent of whether metrics meet their floors").
  console.error('Golden-set eval failed:', err);
  process.exitCode = 1;
});
