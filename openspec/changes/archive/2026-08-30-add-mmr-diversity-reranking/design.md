## Context

`SearchService.search()` (`src/search/index.ts:82-135`) is the single entry point
`recall` and `search` use. It dispatches to `semanticSearch`, `fulltextSearch`, or
`hybridSearch`, each of which funnels its ranked candidates through
`buildSearchResults` (`src/search/index.ts:332-392`), which now applies the composite
`relevance × prior` score from `add-composite-recall-ranking` and re-sorts.

Vectors are already returned per-candidate by Qdrant when asked
(`storage/qdrant.ts:160-213`, `with_vector`), but only `hybridSearch`'s private
`withVectors` flag — set exclusively by `searchForInject` — requests them;
`semanticSearch` never does, and `search()`'s public switch statement doesn't expose
the option at all.

`memory://inject/{hint}` (`src/resources/index.ts:187-203`,
`add-relevance-conditioned-inject`) already suppresses near-duplicates: a greedy pass
that drops a candidate once its similarity to an already-selected memory exceeds
`deduplication.similarity_threshold` (default `0.92`). That is a binary drop rule
tuned for "these are basically the same memory," not MMR's continuous
relevance/diversity trade-off, and it only runs for that one hint-driven resource
template — `recall`/`search`, the paths every other MCP tool call goes through, have
no diversity step.

`recall` (`src/tools/index.ts:156-205`) already over-fetches
(`fetchLimit = Math.min(input.limit * 2, 40)`) so expired-memory filtering doesn't
starve the caller's `limit`. `search` (`src/tools/index.ts:224-237`) fetches exactly
`input.limit` from the store today — no headroom for anything to select *among*.

## Goals / Non-Goals

Goals:
- General MMR-style diversity reranking for `recall` and `search` (semantic and
  hybrid modes), operating on the already-computed composite score, not raw cosine.
- Config-driven with a conservative default so a pool with no near-duplicates is
  barely reordered.
- Reuse, not duplicate, the vector-fetch plumbing and similarity math
  `add-relevance-conditioned-inject` already introduced.
- No change to `min_score`/type/tags filtering semantics or to `memory://inject`'s
  existing behavior (hinted or not).

Non-Goals:
- Not rewriting or unifying `memory://inject/{hint}`'s own near-duplicate suppression
  algorithm. Only its `cosineSimilarity` helper is extracted to a shared location to
  avoid a second near-identical implementation; `suppressNearDuplicates`'s
  threshold-drop logic and behavior stay exactly as `add-relevance-conditioned-inject`
  shipped them. A future change could consider unifying the two mechanisms; out of
  scope here.
- No new tokenizer or embedding work — reuses whatever vectors Qdrant already returns
  for the query.
- No learned λ or feedback loop.
- No cross-mode pool mixing (a semantic-mode pool is never reranked against a
  hybrid-mode pool; each `search()` call reorders only its own candidates).
- No change to which candidates the stores return before this pool is assembled
  (that's filter push-down / FTS5 territory, already covered by
  `push-down-recall-filters` and `upgrade-fulltext-to-fts5`).

## Decisions

- **Full-pool reorder, not top-K selection.** `mmrRerank(results, lambda)` returns
  every input result reordered by the MMR trade-off — it never drops a candidate.
  Truncation, `min_score`, and type/tags filtering stay exactly where they are today,
  in `tools/index.ts`, applied *after* the reorder. This sidesteps a real correctness
  trap: `recall`'s `min_score` filter (`tools/index.ts:202`) runs *before* the final
  `.slice(0, input.limit)` today. If MMR instead truncated the pool down to `limit`
  inside `search()`, `min_score` could then shrink that already-`limit`-sized set with
  no pool left to backfill from — silently under-returning results even when enough
  qualifying candidates existed. Reordering the full pool and leaving truncation
  downstream avoids this entirely.
- **Scoped to `search()` only.** `searchForInject` (and therefore
  `memory://inject/{hint}`) is untouched. Running MMR reordering *and* the existing
  threshold suppression over the same pool would compose unpredictably and change
  already-shipped, already-tested inject behavior as a side effect of this proposal —
  explicitly out of scope per the Non-Goals above.
- **Per-pool score normalization.** Semantic-mode composite scores
  (`cosine × prior`, roughly `[0, ~1.3]`) are already comparable in scale to cosine
  similarity (`~[0,1]`), but hybrid-mode's RRF-derived composite scores are tiny
  (`~0.01–0.05`, see `add-composite-recall-ranking`'s design notes on RRF scale). Used
  directly, the diversity penalty term would dwarf hybrid-mode's relevance term
  regardless of `lambda`. Min-max normalize `.score` across the fetched pool before
  computing the trade-off — `(score - poolMin) / (poolMax - poolMin)`, falling back to
  `1` for every candidate when the pool has zero score spread (in which case only
  diversity differentiates them, which is the correct behavior for a tied pool) — so
  `lambda` means the same thing in every mode.
- **Vector plumbing generalized, not duplicated.** `semanticSearch` gains the same
  `{ ...(filter ?? {}), withVector: true }` request pattern `hybridSearch` already has
  (`src/search/index.ts:219-221`), gated on
  `search.mmr.enabled && mode !== 'fulltext'` computed once inside `search()`, rather
  than a bespoke boolean threaded in by each caller. `search()` strips `.vector` from
  every result before returning (mutating it to `undefined`, dropped by
  `JSON.stringify`), so the "never populated in public tool responses" contract on
  `SearchResult.vector` (`src/domain/types.ts:99-103`) continues to hold; only
  `searchForInject`'s callers still see it.
- **Candidate-pool headroom.** `recall`'s `fetchLimit` and a new equivalent for
  `search` both become
  `Math.min(limit * mmr.candidate_pool_multiplier, mmr.candidate_pool_cap)` when MMR
  is eligible (mode has vectors, `search.mmr.enabled`); byte-identical to today's
  formula (`recall`'s `min(limit*2,40)`, `search`'s exact `limit`) otherwise.
- **Shared `cosineSimilarity`.** Extracted out of `src/resources/index.ts:171-185`
  into a small shared module both `SearchService` and `ResourceHandler` import. No
  behavior change to `suppressNearDuplicates` — same threshold, same greedy pass,
  same outputs; only the function's location changes.
- **Defaults.** `enabled: true`, `lambda: 0.7` (mildly diversity-aware — a genuine
  near-duplicate cluster gets broken up; two distinct, both-relevant memories barely
  move), `candidate_pool_multiplier: 3`, `candidate_pool_cap: 50` (matches `search`'s
  own maximum `limit`). Mirrors `search.ranking`'s and `auto_inject.dedup_suppression`'s
  precedent of shipping the improvement on by default with conservative constants and
  a kill switch, rather than opt-in.

## Risks / Trade-offs

- Enabled by default, MMR changes not just ordering but which memories survive a
  truncated top-K whenever the fetched pool actually contains near-duplicates —
  mitigated by the conservative default `lambda` and the `search.mmr.enabled: false`
  kill switch.
- The greedy reorder is `O(n²)` over the candidate pool; bounded by
  `candidate_pool_cap` (50), negligible at that size.
- Requesting vectors and a wider pool increases Qdrant round-trip payload size;
  bounded by the same cap and skipped entirely for fulltext-only search (no vectors
  exist there).
- Two independent near-duplicate mechanisms now coexist by design: `memory://
  inject/{hint}`'s hard threshold drop and `recall`/`search`'s soft MMR trade-off.
  Intentional (see Non-Goals), but must be documented clearly so operators don't
  expect identical behavior between the two surfaces.
- `min_score` (`recall`) is calibrated against `semantic_score`, never against the
  composite/MMR-influenced `score`. Unaffected by construction since MMR only
  reorders `score`-adjacent results and never touches `semantic_score`/
  `fulltext_score` — explicitly regression-tested rather than merely asserted.
