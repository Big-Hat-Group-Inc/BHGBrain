## 1. Eligibility and Result Budgets

- [x] 1.1 Extract one clock-aware active-memory eligibility predicate and verify the same expiry boundary across search, recall, direct resources, lists, and collections.
- [x] 1.2 Apply eligibility to linked neighbors, pinned/inject candidates, and payload fallbacks and verify expired linked or pinned memories never surface.
- [x] 1.3 Move expiry filtering into storage queries where possible and over-fetch/backfill elsewhere; verify full-text search returns the requested live limit when expired matches rank first.
- [x] 1.4 Add a separate bounded archive-result budget and schema/docs fields and verify `include_archived` returns marked archive matches even when active results fill their limit.

## 2. Query and Ranking Semantics

- [x] 2.1 Add shared token normalization that drops untokenizable terms, safely quotes FTS input, and explicitly returns no matches for an empty normalized query; verify punctuation and emoji fixtures.
- [x] 2.2 Escape LIKE wildcards and the escape character in archive fallback search and verify `%` and `_` cannot enumerate unrelated rows.
- [x] 2.3 Replace fixed full-text score division with monotonic candidate-relative normalization and verify distinct BM25 ranks remain ordered in hybrid fusion.
- [x] 2.4 Add memory-ID tie-breakers to every membership-affecting sort and verify equal-score inputs yield stable order and cutoff membership.
- [x] 2.5 Keep reranked candidates ahead of the untouched population and verify out-of-pool composite scores cannot overtake evaluated results.

## 3. Consolidation and Validation

- [x] 3.1 Finalize `merged_from` from per-source success/pending/failure outcomes and verify partial deletion does not claim a fully completed merge.
- [x] 3.2 Log and return structured per-source consolidation failures and verify Qdrant, lifecycle-lock, and not-found causes remain distinguishable.
- [ ] 3.3 Add cross-surface retrieval fixtures and run targeted search/resource/tool tests, `npm run eval`, `npm run lint`, `npm test`, and `npm run build`; record relevance changes for review.
