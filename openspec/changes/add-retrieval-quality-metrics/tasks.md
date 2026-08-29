## 1. Metrics collector: labeled counters

- [x] 1.1 Extend `incCounter` (`src/health/metrics.ts:78`) to
  `incCounter(name: string, amount = 1, labels?: Record<string, string>): void`. Key
  storage the same way `recordHistogram` already does via `histogramKey(name, labels)`
  (`:61-65`).
- [x] 1.2 Change `counters` (`src/health/metrics.ts:69`) from `Map<string, number>` to
  `Map<string, { name: string; labels?: Record<string, string>; value: number }>`,
  updating `incCounter`'s read-modify-write (`:79-81`) to key/store through it.
- [x] 1.3 Update the counters loop in `getMetrics()` (`:104-106`) to emit `labels` on
  each counter `MetricEntry`, matching how the histogram loop (`:107-122`) already does.
- [x] 1.4 Tests in `src/health/metrics.test.ts`: a labeled `incCounter` call accumulates
  independently per distinct label set (mirroring the existing labeled-histogram test,
  "buckets a labeled histogram separately per distinct label set", `:136`); confirm the
  existing unlabeled-counter tests (`:82-98`) still pass unmodified, proving the new
  parameter is backward-compatible.

## 2. Search-mode result-count and score histograms

- [x] 2.1 In `SearchService.search()` (`src/search/index.ts`), after the mode `switch`
  closes (`:122`) and before the `includeArchived` block (`:124`), record
  `search_result_count` (histogram, `{ mode }`) with `results.length`, then loop over
  `results` recording `search_result_score` (histogram, `{ mode }`) with each result's
  `.score`. Both must read the mode-specific `results` array, not the post-archived-
  append value, so the placeholder `score: 0` archived entries (`:39-41`, `:49`) never
  enter the score histogram.
- [x] 2.2 Tests in `src/search/index.test.ts`: for each of `semantic`, `fulltext`,
  `hybrid`, confirm `search_result_count` and `search_result_score` are recorded with
  `{ mode: <that mode> }` and the expected values (reuse the existing per-mode test
  setups already in this file, e.g. the fulltext/hybrid cases around `:322-360`); a
  zero-result search records `search_result_count` as `0` and records no
  `search_result_score` samples; an `includeArchived: true` call with archived matches
  does not add archived scores to `search_result_score`.

## 3. Degraded-mode frequency per namespace

- [x] 3.1 Add a `{ namespace }` label to the `search_embedding_degraded` call in
  `hybridSearch` (`src/search/index.ts:231`), using the `namespace` parameter already in
  scope (`:194`).
- [x] 3.2 Update the existing assertion pinning the old unlabeled call shape
  (`src/search/index.test.ts:346`, `expect(metrics.incCounter).toHaveBeenCalledWith
  ('search_embedding_degraded')`) to assert the labeled shape
  (`'search_embedding_degraded', 1, { namespace: 'global' }`, matching that test's
  `service.search('hello', 'global', ...)` call).
- [x] 3.3 Add a test with a second, distinct namespace confirming
  `search_embedding_degraded` accumulates independently per namespace (two separate
  degraded hybrid searches in different namespaces produce two separate counter
  entries, each with `value: 1`).

## 4. Docs

- [x] 4.1 Add rows to the `README.md` § Metrics table (`:1911-1924`) for
  `search_result_count_avg/_p50/_p95/_p99/_count` and
  `search_result_score_avg/_p50/_p95/_p99/_count` (each noting the `mode` label), and
  update the `search_embedding_degraded` row (add it if still absent, or update it) to
  document the new `namespace` label — this is the metric's first appearance in
  README.
- [x] 4.2 Apply the identical table additions/updates to `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md`, section-for-section with `README.md`.
- [x] 4.3 Bump the `version` field in `package.json` (user-visible `/metrics` output
  change).
- [x] 4.4 No `.env.example` changes required — no new environment variables are
  introduced (confirm during review).

## 5. Validation

- [x] 5.1 `npm run lint` (`tsc --noEmit` + `eslint src`) passes.
- [x] 5.2 `npm test` passes, including the new/updated tests in
  `src/health/metrics.test.ts` and `src/search/index.test.ts`. (One `http.test.ts`
  health-endpoint test timed out under full-suite CPU contention on a single run;
  it passed in isolation and passed on a clean re-run of the full suite - pre-existing
  flakiness unrelated to this change, which touches only `src/health/metrics.ts` and
  `src/search/index.ts`.)
- [x] 5.3 Confirm README ×5 stayed in sync: grep for `search_result_count`,
  `search_result_score`, and `search_embedding_degraded` across all five README files
  and confirm identical rows/wording modulo translation.
