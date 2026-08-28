## 1. Config schema

- [ ] 1.1 Add a `search.mmr` block to the Zod config schema (`src/config/index.ts`,
  after the `ranking` block that ends around line 177): `enabled` (default `true`),
  `lambda` (`0`-`1`, default `0.7`), `candidate_pool_multiplier` (positive number,
  default `3`), `candidate_pool_cap` (positive int, default `50`).
- [ ] 1.2 Document the block in `.env.example`'s config-reference comments only if
  applicable (no new env vars are introduced — `search.ranking` set the precedent of
  not needing one) and in `AGENTS.md` only if the "Config vs. environment" guidance
  needs updating (it enumerates env-var categories, not individual `search.*` fields,
  so this likely doesn't apply — confirm rather than assume). README.md + translations
  are the primary doc surface (task 7.1).

## 2. Shared similarity helper

- [ ] 2.1 Extract `cosineSimilarity` (currently private to `ResourceHandler`,
  `src/resources/index.ts:171-185`) into a small shared module (e.g.
  `src/search/similarity.ts`) exporting `cosineSimilarity(a: number[], b: number[]):
  number`, with identical implementation and behavior.
- [ ] 2.2 Update `src/resources/index.ts` to import and use the shared function in
  place of its private method; `suppressNearDuplicates` (`src/resources/index.ts:187-
  203`) and its behavior/tests are otherwise untouched.

## 3. Vector plumbing

- [ ] 3.1 Add a `withVectors` parameter to `semanticSearch`
  (`src/search/index.ts:137-168`), mirroring the pattern already in `hybridSearch`
  (`src/search/index.ts:219-221`): when `true`, request
  `{ ...(filter ?? {}), withVector: true }` from `storage.qdrant.search` instead of
  the bare `filter`; default `false` so behavior is unchanged unless explicitly
  requested.
- [ ] 3.2 In the public `search()` method (`src/search/index.ts:82-135`), compute
  `const wantVectors = this.config.search.mmr.enabled && mode !== 'fulltext';` once,
  and pass it into the `semanticSearch`/`hybridSearch` branches of the mode switch
  (`hybridSearch` already accepts this as its 7th positional `withVectors` argument;
  wire the same value in rather than the current implicit `false`).

## 4. MMR reordering

- [ ] 4.1 Add `mmrRerank(results: SearchResult[], lambda: number): SearchResult[]` to
  `SearchService`. Behavior: min-max normalize `.score` across `results`
  (`(score - min) / (max - min)`, or `1` for every item when `max === min`); greedily
  reorder starting from the highest-scoring item, at each step picking the unselected
  candidate maximizing `lambda * normScore - (1 - lambda) * maxSimilarityToSelected`
  (similarity against already-selected items with a vector, using the shared
  `cosineSimilarity` from task 2.1; `0` for any candidate or comparison missing a
  vector, so vector-less candidates are never penalized nor able to penalize others).
  Returns every input result reordered — same length, no drops. No-op (return as-is)
  when `results.length <= 1`.
- [ ] 4.2 In `search()`, after the mode switch produces `results` and before the
  `includeArchived` append (`src/search/index.ts:124`), apply the reorder:
  `results = wantVectors && results.length > 1 ? this.mmrRerank(results,
  this.config.search.mmr.lambda) : results;`.
- [ ] 4.3 Before `search()` returns, clear the transient `.vector` field on every
  result (set to `undefined`, dropped by `JSON.stringify`) so the public contract
  holds. Update the `SearchResult.vector` comment (`src/domain/types.ts:99-103`) to
  note it is also used as MMR scratch space inside `search()` before being cleared,
  while `searchForInject`'s callers still receive it populated.

## 5. Candidate pool headroom

- [ ] 5.1 In `handleRecall` (`src/tools/index.ts:170-178`), replace the fixed
  `fetchLimit = Math.min(input.limit * 2, 40)` with a config-driven pool size when
  MMR is eligible:
  `ctx.config.search.mmr.enabled ? Math.min(input.limit * ctx.config.search.mmr.candidate_pool_multiplier, ctx.config.search.mmr.candidate_pool_cap) : Math.min(input.limit * 2, 40)`.
  (`recall` is semantic-only, so no mode check is needed here.)
- [ ] 5.2 In `handleSearch` (`src/tools/index.ts:224-237`), fetch a wider pool using
  the same formula as 5.1 whenever `input.mode !== 'fulltext' &&
  ctx.config.search.mmr.enabled`, otherwise keep fetching exactly `input.limit` as
  today. Since `search()` no longer returns an exactly-`limit`-sized array in the
  MMR-eligible case, add an explicit `.slice(0, input.limit)` before returning from
  `handleSearch` (mirroring how `handleRecall` already truncates after its own
  filtering).

## 6. Tests

- [ ] 6.1 Diversity test: seed a near-duplicate high-relevance cluster plus one
  distinct, slightly-lower-relevance memory; assert the distinct memory is promoted
  into the returned top-K when `search.mmr.enabled` is `true`, and stays excluded
  when `false` (pure composite-relevance ordering, current behavior).
- [ ] 6.2 Lambda test: `lambda: 1` reduces to (near) pure composite-relevance
  ordering (no diversity term); a low `lambda` (e.g. `0.1`) visibly favors
  dissimilar candidates over marginally-more-relevant near-duplicates in a fixture
  with well-separated vectors.
- [ ] 6.3 Fulltext no-op test: `search` with `mode: 'fulltext'` is unaffected by
  `search.mmr.enabled` (no vectors exist to diversify against).
- [ ] 6.4 Scale-normalization test: hybrid-mode (tiny RRF-scale composite scores) and
  semantic-mode (cosine-scale composite scores) diversify consistently given
  equivalent relative relevance gaps between fixture memories — regression guard for
  the min-max normalization decision.
- [ ] 6.5 `min_score` regression: `recall`'s `min_score` filter still applies to
  `semantic_score` post-reorder and still returns up to `limit` results whenever
  enough pool candidates clear the threshold — guards against the under-return trap
  described in `design.md`.
- [ ] 6.6 Vector-leakage regression: `search()`'s JSON-serializable output never
  contains a populated `vector` field, with `search.mmr.enabled` both `true` and
  `false`; `searchForInject`'s existing vector-carrying contract is unaffected.
- [ ] 6.7 `memory://inject/{hint}` regression: near-duplicate suppression output and
  its existing test suite are unaffected by the `cosineSimilarity` extraction (task
  2) — same inputs produce the same outputs.

## 7. Docs

- [ ] 7.1 Document `search.mmr` config and the full ranking pipeline order
  (relevance → composite prior → MMR diversity reorder → downstream `min_score`/
  type/tags filtering and truncation) in `README.md`, near the existing "Composite
  Ranking" section (`README.md:1593-1700`), and in `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md`. Explicitly note that `memory://inject/{hint}`'s
  near-duplicate suppression is a separate, pre-existing mechanism with different
  semantics (hard threshold vs. MMR trade-off), not superseded by this change.
- [ ] 7.2 Bump `package.json` `version` (user-visible ranking behavior change).
- [ ] 7.3 `npm run lint` and `npm test` pass.
