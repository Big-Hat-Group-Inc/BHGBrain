# Code Audit — OpenSpec proposal `add-percentile-metrics`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `add-percentile-metrics`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 8 (`src/health/metrics.ts`, `src/health/metrics.test.ts`, `src/embedding/index.ts`, `src/embedding/azure-foundry.ts`, `src/search/index.ts`, `src/tools/index.ts`, `src/transport/http.ts`, `README.md`; plus proposal/tasks/design)

## Executive summary

The proposal is well-scoped and the implementation is faithful to it: `computePercentile` plus p50/p95/p99 emission, instrumentation at all four named call sites, and tests covering empty/single/known-distribution/overflow cases. Overall health is good. There are no Critical or High issues. The most material defect is an **observability gap**: tool-handler latency is recorded only on the success path, so the percentiles that justify this change systematically exclude slow failures — the exact tail the proposal exists to surface. Secondary issues are a minor spec drift in tool-metric naming, a `/metrics` serializer that silently drops `labels` and emits no Prometheus `# TYPE`/`# HELP` lines, and small-sample percentile collapse that is mathematically correct but undocumented. Headline counts: 0 Critical, 0 High, 3 Medium, 5 Low.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Cap. `histogram-percentile-metrics`: compute & emit p50/p95/p99 for all histograms | Done | `src/health/metrics.ts:93-96` |
| `computePercentile(values, p)` utility; sorts a copy, no buffer mutation | Done | `src/health/metrics.ts:10-18`; sort of copy at `92` |
| `/metrics` plain-text output gains new lines, additive/backward-compatible | Done | `src/transport/http.ts:63` emits `${name}_p50/_p95/_p99`; existing `_avg`/`_count` preserved at `93,97` |
| 1.1 Module-level `computePercentile`, nearest-rank | Done | `src/health/metrics.ts:10-18` (`Math.ceil((p/100)*n)`) |
| 1.2 Sort copy of `buf.values()`, emit p50/p95/p99 with `_avg`/`_count` | Done | `src/health/metrics.ts:88-97` |
| 1.3 Names `${name}_p50/_p95/_p99`, type `'histogram'` | Done | `src/health/metrics.ts:94-96` |
| 1.4 Empty buffer → 0 for all percentiles | Done | `src/health/metrics.ts:11-13`; guard verified by test `metrics.test.ts:82` |
| 2.1 `embedding_embed_batch_ms` via MetricsCollector injection | Done | `src/embedding/index.ts:52`; provider ctor `28`; also Azure `src/embedding/azure-foundry.ts:96` |
| 2.2 `search_total_ms` over `search()` for each mode | Done | `src/search/index.ts:39,52` (finally wraps all modes) |
| 2.3 `tool_handler_ms` per-tool metric name | **Drifted** | `src/tools/index.ts:58` uses single `bhgbrain_tool_handler_ms` with **no** per-tool name or label; task text asked for per-tool (`tool_remember_ms`, …) |
| 2.4 MetricsCollector accessible at all call sites | Done | `ToolContext.metrics` `src/tools/index.ts:30`; providers/search take optional `metrics?` |
| 3.1 Update http.ts inline comment re p50/p95/p99 | Done | `src/transport/http.ts:61` |
| 3.2 README observability section lists new metric names | Done | `README.md:1718-1723,2495,2633` |
| 4.1 Test `_p50/_p95/_p99` emitted for known values | Done | `src/health/metrics.test.ts:65-79` |
| 4.2 `computePercentile` empty→0, single→value, [1..100] | Done | `src/health/metrics.test.ts:81-89` |
| 4.3 Overflow >1000 reflects most recent 1000 | Done | `src/health/metrics.test.ts:91-102` |
| 5.1 `npm test` passes | Partial | Not independently re-run in this audit; tasks marked `[x]` |
| 5.2/5.3 Commit & push | Partial | Commit message not found in `git log` grep for percentile/metric; tasks marked `[x]` (cannot verify) |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | Medium | High | S | Logging | `src/tools/index.ts:58,62` | Tool latency recorded only on success; failures excluded from percentiles |
| 2 | Medium | High | S | Maintainability | `src/tools/index.ts:58` | Spec drift: single metric, no per-tool name/label (task 2.3) |
| 3 | Medium | Medium | S | Maintainability | `src/transport/http.ts:63` | `/metrics` drops `labels`; no Prometheus `# TYPE`/`# HELP` |
| 4 | Low | High | S | Maintainability | `src/health/metrics.ts:97` | `_count` typed `'counter'` but is a histogram cardinality |
| 5 | Low | High | S | Performance | `src/health/metrics.ts:92` | `sort` runs even when count===0 (cheap, but unguarded) |
| 6 | Low | Medium | S | Testing | `src/health/metrics.test.ts` | No test for small-sample p95≈p99 collapse or labels rendering |
| 7 | Low | Low | S | Stability | `src/health/metrics.ts:15` | Non-integer `p` not validated; out-of-range `p` clamps silently |
| 8 | Low | Low | S | Maintainability | `src/health/metrics.ts:88-91` | `_avg` recomputes `sum/reduce` separately from sorted copy (minor dup) |

## Quick wins

- Record `bhgbrain_tool_handler_ms` in a `finally` so failures are included (Finding 1) — one-line move of the `recordHistogram` call.
- Add a `tool` label or per-tool metric name to satisfy task 2.3 (Finding 2).
- Emit Prometheus `# TYPE` lines and render `labels` in the `/metrics` serializer (Finding 3).

## Performance

### [Low · High · S] Sort executed for empty histograms — `src/health/metrics.ts:92`
**Issue:** `const sortedValues = [...vals].sort(...)` runs unconditionally, even when `count === 0`. The `_avg` path already guards `count > 0`, but the sort/copy does not.
**Why it matters:** Negligible cost (sorting `[]`), but inconsistent with the surrounding guarded code and produces four percentile entries (all 0) for histograms that have been created but currently hold no values. Mostly a clarity issue.
**Recommendation:** Skip the sort and percentile emission when `count === 0`, or keep but add a comment. Per-`getMetrics` cost for real buffers (≤1000 numbers) is well within the design's stated <1ms budget, so no action needed for hot-path performance.

## Logging & observability

### [Medium · High · S] Tool-handler latency excludes the failure tail — `src/tools/index.ts:58,62`
**Issue:** `recordHistogram('bhgbrain_tool_handler_ms', duration)` is called only inside the `try` success branch (`:58`). The `catch` block computes `duration` (`:62`) for logging but never records it to the histogram.
**Why it matters:** The entire motivation in `proposal.md` is that "a fast average can mask a slow tail." Failures (timeouts, circuit-breaker opens, embedding-provider unreachable) are frequently the slowest requests. Excluding them biases p95/p99 *downward* precisely where the signal matters, undermining the SLO value this change was meant to add. By contrast, `search_total_ms` and `embedding_embed_batch_ms` correctly use `finally` (`src/search/index.ts:52`, `src/embedding/index.ts:52`), so this call site is inconsistent with its siblings.
**Recommendation:** Move the `recordHistogram` into a `finally` block (capturing duration once), matching the search/embedding instrumentation pattern. Optionally tag a `status` (ok/error) label or use a counter to retain success/error split.

## Stability & reliability

### [Low · Low · S] `computePercentile` does not validate `p` — `src/health/metrics.ts:15`
**Issue:** `p` is assumed to be 0–100. A value >100 yields `rank > length`, then `Math.min(length-1, …)` clamps to the max element; a negative `p` clamps to index 0. Non-integer `p` works but is undocumented.
**Why it matters:** All current callers pass literal 50/95/99, so there is no live bug. The clamping silently returns a plausible-looking number for nonsensical input, which could mislead a future caller.
**Recommendation:** This is an internal utility with fixed callers — low priority. If exported for reuse, add a brief JSDoc noting the expected 0–100 range (nearest-rank) and consider asserting in dev.

## Security

No issues found. The change emits only numeric latency aggregates; no PII, secrets, or user content flows into metrics. `/metrics` remains gated behind `config.observability.metrics_enabled` (`src/transport/http.ts:59`) and the existing HTTP auth/loopback controls, which are out of scope for this proposal.

## Maintainability & code quality

### [Medium · High · S] Spec drift: single tool metric instead of per-tool name/label — `src/tools/index.ts:58`
**Issue:** Task 2.3 asks for "`tool_handler_ms` with a label dimension or per-tool metric name (e.g., `tool_remember_ms`, `tool_recall_ms`)." The implementation records one undifferentiated `bhgbrain_tool_handler_ms` for all 12 tools, with no `labels` and no per-tool name.
**Why it matters:** Aggregating `remember` (write + embed + Qdrant) and `recall` (read) into one histogram defeats the design's stated principle of per-layer latency attribution (`design.md:42-44`). You cannot tell which tool is slow from `/metrics`. The task was checked `[x]` but the deliverable does not match either offered option.
**Recommendation:** Add `labels: { tool: toolName }` to the metric (the `MetricEntry` type already supports `labels` at `src/health/metrics.ts:7`) or emit `bhgbrain_tool_${toolName}_ms`. Note this depends on Finding 3 — the serializer must actually render labels for a label-based approach to be observable.

### [Medium · Medium · S] `/metrics` serializer discards labels and omits Prometheus type metadata — `src/transport/http.ts:63`
**Issue:** `lines = metrics.map(m => \`${m.name} ${m.value}\`)` ignores `m.labels` entirely and emits no `# TYPE`/`# HELP` lines, despite `MetricEntry.labels` existing (`src/health/metrics.ts:7`) and the design citing "Prometheus-style scrapers" (`design.md:25`).
**Why it matters:** (a) Any future label-based metric (Finding 2's recommended fix) would be silently flattened — multiple tools' values would collide under one line. (b) Without `# TYPE`, Prometheus infers types and the `_count` entry (typed `counter`, see Finding 4) is ambiguous. This caps the usefulness of the percentile output for real scraping.
**Recommendation:** Render labels as `name{k="v",…} value` and emit `# TYPE name histogram` once per family. Low urgency while no labels are used, but it blocks the cleanest fix for Finding 2.

### [Low · High · S] `_count` entry typed as `counter` within a histogram family — `src/health/metrics.ts:97`
**Issue:** The histogram cardinality is pushed as `{ name: \`${name}_count\`, type: 'counter' }` while sibling `_avg`/`_pXX` are `'histogram'`.
**Why it matters:** Purely an internal type-tag inconsistency today (the serializer ignores `type`), but it becomes wrong the moment `# TYPE` lines are emitted (Finding 3), where a `_count` suffix on a histogram family has specific Prometheus meaning.
**Recommendation:** Keep it as part of the histogram family or, when adding `# TYPE`, treat `_count` per Prometheus histogram conventions rather than as a standalone counter.

### [Low · Low · S] `_avg` recomputed independently of the sorted copy — `src/health/metrics.ts:88-91`
**Issue:** `avg` is derived via a separate `reduce` over `vals` while percentiles use `[...vals].sort(...)`. Two passes/copies over the same data.
**Why it matters:** Trivial at n≤1000; flagged only for tidiness. No performance concern.
**Recommendation:** Optional — compute `sum` from the already-sorted array, or leave as-is for readability.

## Testing & coverage

### [Low · Medium · S] Missing tests for small-sample collapse and serializer output — `src/health/metrics.test.ts`
**Issue:** Tests cover empty/single/[1..100]/overflow well, but: (a) the small-sample case where p95 and p99 both equal the max (n=4 → both 40, asserted at `:76-77`) is exercised but not *documented* as expected behavior; (b) there is no test that `getMetrics` produces percentile entries for a histogram alongside a labeled metric; (c) the `/metrics` HTTP serializer (`src/transport/http.ts:63`) has no test asserting percentile lines render.
**Why it matters:** The small-sample collapse is mathematically correct (nearest-rank) but a likely source of future "why is p99==p95?" confusion; an end-to-end serializer test would catch Findings 3/4 regressions.
**Recommendation:** Add a comment/test documenting small-n nearest-rank behavior, and an integration test of the `/metrics` text output once labels/TYPE are addressed.

## Dependencies & supply chain

No issues found. The change introduces no new dependencies; percentile computation is pure in-tree arithmetic using the existing bounded buffer. No t-digest/DDSketch library was added, consistent with the design's explicit non-goal.

## Recommendations (prioritized)

1. **Record tool latency in `finally` (Finding 1).** Restores the failure tail to p95/p99 — the core value of the proposal. One-line change.
2. **Resolve tool-metric spec drift (Finding 2).** Add a `tool` label or per-tool metric name so latency is attributable per tool, as task 2.3 requires.
3. **Make `/metrics` render labels and `# TYPE`/`# HELP` (Finding 3).** Unblocks the label-based fix above and aligns output with the design's Prometheus-scraper goal.
4. **Align `_count` typing and add a serializer integration test (Findings 4, 6).** Prevents regressions once `# TYPE` lines exist.
5. **Document/guard percentile edge cases (Findings 5, 7).** Skip work for empty histograms and note the expected `p` range / small-sample collapse.
