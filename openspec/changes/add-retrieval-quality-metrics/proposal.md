## Why

The metrics layer records latency (`bhgbrain_tool_handler_ms`, `search_total_ms`,
`embedding_embed_batch_ms`) and one filter-starvation counter, but nothing about
retrieval *quality*. `MetricsCollector` (`src/health/metrics.ts`) has three primitives —
counters, histograms, gauges — and `SearchService` (`src/search/index.ts`) already
computes everything a quality metric would need at the exact moment it's cheapest to
observe:

- `search()` returns a `SearchResult[]` per call but never records how many results came
  back or what mode produced them (`src/search/index.ts:105-134`) — `search_total_ms`
  (`:133`) is the only thing recorded there, and it carries no `mode` label.
- `buildSearchResults` computes the final composite `score` for every result
  (`src/search/index.ts:356-377`) and then discards it once the array is returned —
  there is no record of what scores recall/search actually produce.
- `hybridSearch`'s embedding-outage fallback increments `search_embedding_degraded`
  with no label (`src/search/index.ts:231`), so a degraded namespace is
  indistinguishable from a healthy one in the aggregate count — and the counter isn't
  even in README yet.
- `MetricsCollector.incCounter` (`:78`) takes no `labels` parameter at all, unlike
  `recordHistogram` (`:84-93`), which has supported per-label-set buffers since
  `record-tool-latency-on-all-paths`. Nothing today can *ask* for a labeled counter.

`push-down-recall-filters` already closed one piece of this gap: `recall_zero_after_filter`
(`src/tools/index.ts:194`, documented in `README.md:1924`) makes "% of recalls returning
zero after filtering" observable. That is the *only* item from the brainstorm's retrieval-
quality list that is built. This proposal is scoped to the three that remain: result-count
distribution per mode, score distributions, and degraded-mode frequency per namespace. It
does not touch `recall_zero_after_filter` or filter push-down in any way.

## What Changes

- Extend `MetricsCollector.incCounter` to accept an optional `labels` parameter, storing
  counters keyed by name+label-set (reusing the same keying scheme `recordHistogram`
  already uses) so counters can be labeled exactly like histograms are today.
- Record `search_result_count` (histogram, labeled `mode`) once per `SearchService.search()`
  call — the number of mode-specific results returned, before archived matches (which
  carry a placeholder, non-relevance score) are appended.
- Record `search_result_score` (histogram, labeled `mode`) for every result's composite
  `score`, at the same instrumentation point, so recall/search score distributions become
  visible per mode.
- Add a `namespace` label to the existing `search_embedding_degraded` counter so
  degraded-hybrid-fallback frequency is attributable per namespace instead of a single
  opaque global count.
- Document all three metrics (two new, one newly-labeled) in `README.md` § Metrics and
  the four translated READMEs; bump `package.json` version.

## Capabilities

### New Capabilities
- `retrieval-quality-metrics`: search/recall expose result-count distribution per mode,
  result-score distribution per mode, and degraded-hybrid-fallback frequency per
  namespace via the existing Prometheus `/metrics` endpoint.

### Modified Capabilities

## Impact

- Affected code: `src/health/metrics.ts` (`incCounter` labels, counter storage shape,
  `getMetrics()`), `src/search/index.ts` (`search()` instrumentation, `hybridSearch`
  namespace label), co-located tests (`src/health/metrics.test.ts`,
  `src/search/index.test.ts`).
- Behavior: `/metrics` gains two new labeled metric families and the existing
  `search_embedding_degraded` counter changes shape from one global series to one series
  per namespace. That counter has never been documented in README, so this is its first
  external contract, not a break of one.
- Docs: README ×5 (§ Metrics table), `.env.example` unchanged (no new env vars), version
  bump.
- Depends on: nothing; extends the labeled-metric infrastructure landed in
  `record-tool-latency-on-all-paths` (per-label histogram buffers, `# TYPE`/label
  Prometheus serialization). Does not re-propose `recall_zero_after_filter`
  (`push-down-recall-filters`) or change ranking behavior
  (`add-composite-recall-ranking`) — it only observes the score that ranking produces.
