## Why

Retrieval quality in this repo is currently verified only at the unit level, with every
dependency mocked. `src/search/index.test.ts` constructs `SearchService` against a
hand-rolled `storage` object whose `sqlite.fullTextSearch`/`qdrant.search` are
`vi.fn()`s returning fixed arrays (`src/search/index.test.ts:38-52`), and
`src/storage/qdrant.test.ts` mocks the `@qdrant/js-client-rest` client entirely
(`src/storage/qdrant.test.ts:13-17`). These tests correctly verify that
`buildSearchResults`/`compositeScore` *apply a formula* given inputs the test already
picked — they cannot tell whether that formula, or the fulltext matcher underneath it,
actually surfaces the right memory for a real query.

Five retrieval-affecting changes landed in this branch in the last day: composite
ranking (`src/search/index.ts:302-330`, `compositeScore`), recall filter push-down
(`src/tools/index.ts:156-205`, `handleRecall`), relevance-conditioned inject
(`SearchService.searchForInject`, `src/search/index.ts:293-300`), review/archive recall
(`archiveRecordToSearchResult`, `src/search/index.ts:42-58`), and a partially-landed
FTS5 migration that has not yet replaced the legacy matcher — `fullTextSearch`
(`src/storage/sqlite.ts:726`) still runs `LIKE '%term%'` scoring because
`isFts5Available()` (`src/storage/sqlite.ts:418-420`) is hard-coded `false` against the
pinned sql.js build (see `AGENTS.md` gotcha 9 and `openspec/changes/
upgrade-fulltext-to-fts5`, 3/14 tasks done). Every one of these was reviewed by reading
the diff and reasoning about the formula, not by measuring whether real queries find the
right memory. There is no regression signal if a future change — including finishing
the FTS5 migration — silently makes retrieval worse while every unit test (which
supplies its own expected output) keeps passing.

codeaudit/storagefeaturebrainstorm.md (§6.3) names exactly this gap: a golden-set eval
— fixed (query → expected memory) pairs run against a seeded store, scored with
recall@k and MRR — so retrieval-affecting changes are measured, not eyeballed.

## What Changes

- Add a golden-set fixture: ~50 `(query, expected memory)` pairs plus a larger seeded
  corpus of distractor memories (so recall@k is non-trivial), stored as data under
  `src/eval/fixtures/`.
- Add an eval harness (`src/eval/harness.ts`) that seeds a **real** `SqliteStore`
  (temp-dir-per-run, matching `src/storage/sqlite.test.ts`'s pattern) and a **real**
  `QdrantStore` backed by an in-memory fake `QdrantClient` (matching
  `src/storage/qdrant.test.ts`'s `MockQdrantClient` pattern, extended to perform actual
  cosine top-k over in-memory points instead of returning canned results), driven by a
  deterministic hash-based fixture `EmbeddingProvider` (no network calls, no API key).
  Queries run through the production `SearchService.search` — the same code path
  `recall`/`search` use — so composite ranking, RRF fusion, filter push-down, and the
  current LIKE-based fulltext matcher are all exercised as shipped, not reimplemented.
- Compute recall@1 / recall@5 / recall@10 and MRR@10 per query and in aggregate.
- Wire the harness into the existing test suite as a co-located Vitest spec
  (`src/eval/golden-set.test.ts`) that asserts aggregate metrics stay at or above
  checked-in floors — so it runs in CI for free via the existing `npm test` step in
  `.github/workflows/ci.yml` (no new CI job needed) and fails the build on a real
  retrieval regression.
- Add a `npm run eval` convenience script (`tsx src/eval/run.ts`) that runs the same
  harness standalone and prints a per-query + aggregate report table, for local
  iteration without running the full suite.
- Document the new script in `AGENTS.md`'s Essential Commands section (dev-tooling
  only; no user-facing behavior changes, so no README/version bump).

## Capabilities

### New Capabilities
- `golden-set-eval-harness`: A seeded, deterministic (query → expected memory) fixture
  and runner that scores production retrieval (`SearchService.search`) with recall@k
  and MRR, gated in CI via a Vitest spec with checked-in thresholds.

### Modified Capabilities

## Impact

- New files only: `src/eval/harness.ts`, `src/eval/run.ts`,
  `src/eval/golden-set.test.ts`, `src/eval/fixtures/golden-set.json`,
  `src/eval/fixtures/corpus.json` (or equivalent fixture data files).
- `package.json`: new `scripts.eval` entry. No dependency changes — the harness reuses
  `SqliteStore`, `QdrantStore`, `SearchService`, and existing test doubles patterns
  already in the codebase.
- `AGENTS.md`: Essential Commands gains the `npm run eval` line.
- No production code in `src/storage`, `src/search`, `src/tools`, or `src/config`
  changes. No user-facing behavior changes; no `README.md`/translation updates; no
  version bump (dev/CI tooling only, consistent with `openspec/changes/
  expand-test-coverage`, which also shipped test-only changes without a version bump).
- Depends on nothing to build — it measures whatever retrieval behavior is currently
  shipped. But its *value* is proportional to how much retrieval logic already exists
  to measure: `push-down-recall-filters`, `add-composite-recall-ranking`,
  `add-relevance-conditioned-inject`, and `add-review-and-archive-recall` are already
  built on this branch, so the harness has real filter push-down, composite ranking,
  near-duplicate suppression, and archive recall to exercise from day one.
  `upgrade-fulltext-to-fts5` is not — the harness's fulltext/hybrid numbers establish
  the **LIKE-matcher baseline**, and re-running `npm run eval` after that migration
  lands is the concrete evidence of whether BM25 actually improved recall, which no
  existing test can currently provide.
