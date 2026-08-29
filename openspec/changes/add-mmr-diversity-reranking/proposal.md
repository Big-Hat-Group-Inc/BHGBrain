## Why

`codeaudit/storagefeaturebrainstorm.md` item 1.6 names it directly: top-K results are
frequently near-duplicates of each other. Two mechanisms exist today that touch this,
and neither solves it for `recall`/`search`:

- **Write-time dedup** (`config/index.ts:146-149`,
  `deduplication.similarity_threshold`, default `0.92`) only collapses near-*identical*
  content at store time. Two memories at 0.85 similarity — clearly redundant for
  read-time purposes — both get written, both get embedded, and both can surface
  together in one recall.
- **Composite ranking** (`add-composite-recall-ranking`, `buildSearchResults` in
  `src/search/index.ts:332-392`) reorders results by relevance × an
  importance/access/recency prior. It changes *which order* candidates come back in,
  but two near-duplicate memories with similar priors still both rank near the top and
  both consume a slot in the caller's `limit`.
- **`memory://inject/{hint}`** (`add-relevance-conditioned-inject`,
  `suppressNearDuplicates` in `src/resources/index.ts:187-203`) already added
  near-duplicate suppression — but it is a hard threshold drop (`sim > threshold` ⇒
  discard), scoped to that one resource template, and reuses
  `deduplication.similarity_threshold` rather than a relevance/diversity trade-off.
  `recall` and `search` — the general-purpose retrieval path every MCP tool call and
  most inject fallbacks ultimately go through — have no diversity step at all.

Qdrant already returns the candidate vectors on every search (`storage/qdrant.ts:160-
213`, the `withVector` option added by `add-relevance-conditioned-inject`); `recall`'s
`semanticSearch` and `search`'s default `hybridSearch` call simply never ask for them
(`src/domain/types.ts:99-103` documents `SearchResult.vector` as "never populated by
the public `search`/`recall` tools"). Maximal Marginal Relevance — trading a
configurable amount of top-1 relevance for diversity among the selected set — is a
small addition once that plumbing exists, and directly answers the brainstorm's
"small effort once vectors are plumbed through, medium impact" framing.

## What Changes

- Add a `search.mmr` config block (`enabled`, `lambda`, `candidate_pool_multiplier`,
  `candidate_pool_cap`) to `src/config/index.ts`, alongside the existing
  `search.hybrid_weights` and `search.ranking` blocks.
- Extract the `cosineSimilarity` helper already private to
  `src/resources/index.ts:171-185` into a small shared module so this change and
  `memory://inject/{hint}`'s existing suppression use one implementation instead of
  two near-identical ones.
- Generalize the `withVector` request already used privately by `hybridSearch`
  (`src/search/index.ts:219-221`, added for `searchForInject`) so `semanticSearch`
  gains the same capability, gated on `search.mmr.enabled` and mode — not on a
  bespoke per-caller boolean.
- Add `SearchService.mmrRerank`: a full-pool reordering pass (never a truncator) over
  the composite-ranked results returned by `search()`, applied only inside the public
  `search()` entry point that `recall`/`search` use — `searchForInject` and
  `memory://inject/{hint}`'s existing hard-threshold suppression are untouched by this
  change, left as the deliberately separate mechanism `add-relevance-conditioned-inject`
  already shipped.
- Widen the candidate pool `recall` and `search` fetch from the store when MMR is
  eligible (semantic/hybrid modes, `search.mmr.enabled`), so there is genuine
  diversity headroom beyond the caller's requested `limit`; unaffected when disabled
  or in fulltext mode (no vectors to diversify against).
- Strip the transient `.vector` field before `search()` returns, so the "never
  populated in public tool responses" contract on `SearchResult.vector` continues to
  hold.
- Document the new config and the ranking pipeline order (relevance → composite prior
  → MMR diversity reorder → downstream `min_score`/type/tags filtering and
  truncation) in `README.md` and its four translations; bump `package.json` version.

## Capabilities

### New Capabilities
- `mmr-diversity-reranking`: `recall` and `search` (semantic/hybrid modes) reorder
  their composite-ranked candidate pool by Maximal Marginal Relevance, trading a
  configurable amount of top-ranked relevance for diversity so the returned top-K is
  not dominated by near-duplicate memories.

### Modified Capabilities

## Impact

- Affected code: `src/config/index.ts` (new `search.mmr` schema), `src/search/index.ts`
  (`search`, `semanticSearch`, `hybridSearch`, new `mmrRerank`), `src/tools/index.ts`
  (`handleRecall`, `handleSearch` pool sizing), `src/resources/index.ts`
  (`cosineSimilarity` extraction only — no behavior change), `src/domain/types.ts`
  (`SearchResult.vector` comment), a new shared similarity module, co-located tests.
- Behavior: `recall`/`search` ordering — and, since both already truncate to the
  caller's `limit`, which candidates make the returned page — changes when
  `search.mmr.enabled` (default `true`) and the fetched pool contains near-duplicates;
  `enabled: false` restores today's composite-only ordering exactly.
  `memory://inject`/`memory://inject/{hint}` behavior is completely unchanged — a
  separate code path (`searchForInject`) with its own, pre-existing suppression.
- Docs: README ×5, `.env.example` unchanged (no new env vars), version bump.
- Depends on: `add-composite-recall-ranking` (MMR reorders the composite score, not
  raw relevance) and `add-relevance-conditioned-inject` (source of the `withVector`
  plumbing and `cosineSimilarity` helper this proposal generalizes/reuses); both
  already merged.
