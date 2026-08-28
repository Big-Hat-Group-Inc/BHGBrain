## Context

`MetricsCollector` (`src/health/metrics.ts`) has three primitives:

- Counters (`incCounter`, `:78-82`) — a bare `Map<string, number>` (`:69`), no labels.
- Histograms (`recordHistogram`, `:84-93`) — keyed by `histogramKey(name, labels)`
  (`:61-65`) into a `Map<string, HistogramFamily>` (`:70`), so distinct label sets get
  independent bounded buffers and `getMetrics()` (`:100-128`) emits one `avg`/`p50`/
  `p95`/`p99`/`count` entry set per family, each carrying its `labels`.
- Gauges (`setGauge`, `:95-97`) — last-write-wins, no labels.

`record-tool-latency-on-all-paths` built the labeled-histogram machinery and the
Prometheus serializer that renders it: `renderPrometheusText` (`src/transport/http.ts:37-50`)
already emits `name{k="v",...} value` and a `# TYPE` line per metric name for *any*
`MetricEntry`, driven purely by whether `labels` is set — it has no counter/histogram-
specific logic. Counters just never populate `labels` today because `incCounter` has
nowhere to put them.

`SearchService.search()` (`src/search/index.ts:82-135`) is the single choke point every
mode (`semantic`/`fulltext`/`hybrid`) and every caller (`recall` hardcodes `'semantic'`,
`search` takes `input.mode`) funnels through. It already knows `mode`, `namespace`, and
holds the fully-built `SearchResult[]` (composite score already applied by
`buildSearchResults`, `:356`) before returning. `search_total_ms` (`:133`) is recorded
there today, unlabeled, in a `finally`. `hybridSearch` (`:192-283`) is a private method
called from `search()`; it already has `namespace` in scope (`:194`) at the point it
increments `search_embedding_degraded` (`:231`).

Archived matches (`add-review-and-archive-recall`) are appended to `results` *after* the
mode switch, with `score: 0` as a documented placeholder, not a relevance score
(`:39-41` comment, `:49`) — they must not enter a score distribution.

## Goals / Non-Goals

Goals:
- Result-count distribution per search mode.
- Result-score distribution per search mode, using the composite score callers actually
  receive.
- Degraded-hybrid-fallback frequency attributable per namespace.
- Reuse the existing bounded-buffer/Prometheus-label machinery; no new metrics
  subsystem, no new config surface.

Non-Goals:
- Not re-proposing `recall_zero_after_filter` (`push-down-recall-filters`) — that
  already covers "% recalls returning 0 after filtering."
- No alerting rules, dashboards, or SLOs — this proposal only emits raw samples.
- No change to ranking or filtering behavior; these metrics observe outputs that
  `add-composite-recall-ranking` and `push-down-recall-filters` already produce, without
  altering them.
- No cardinality cap on the `namespace` label — flagged as a risk, not solved here.

## Decisions

- **Counters gain labels.** Extend `incCounter(name: string, amount = 1, labels?:
  Record<string, string>)` (`src/health/metrics.ts:78`). Reuse the existing
  `histogramKey` helper (`:61-65`, generalized to a shared `metricKey` if that reads
  better, but behavior-identical) to key counter storage, and change `counters` from
  `Map<string, number>` to `Map<string, { name: string; labels?: Record<string,
  string>; value: number }>` so `getMetrics()`'s counter loop (`:104-106`) can emit
  `labels` exactly as the histogram loop already does. Every existing call site
  (`bhgbrain_tool_calls_total`, `bhgbrain_gc_*`, `degraded_writes_total`,
  `recall_zero_after_filter`, `bhgbrain_rate_limited_total`, the unlabeled
  `search_embedding_degraded` call this proposal changes) omits the new parameter,
  so `histogramKey(name, undefined) === name` and existing keying/behavior is
  unchanged.
- **Instrumentation point: `SearchService.search()`, not the private mode methods.**
  Record `search_result_count` and `search_result_score` once, between the mode
  `switch` closing (`:122`) and the `includeArchived` block (`:124`), using the
  mode-specific `results` array. This gives exactly one instrumentation point
  regardless of mode (no triplication across `semanticSearch`/`fulltextSearch`/
  `hybridSearch`) and naturally excludes archived matches, which are appended after
  this point.
- **Label: `mode` only, three bounded values.** `search_result_count` and
  `search_result_score` are labeled `{ mode }` (`semantic`/`fulltext`/`hybrid`),
  mirroring the `{tool, status}` precedent on `bhgbrain_tool_handler_ms`. No
  `namespace` label on these two — namespace cardinality is unbounded and neither
  metric needs it to answer "is retrieval quality bad for a mode," which is the
  brainstorm's framing.
- **`search_result_score` uses the composite `score`, not `semantic_score`/
  `fulltext_score`.** That is what `buildSearchResults` ranks by and what callers
  receive; it is the field whose distribution answers "does recall feel good."
- **`search_embedding_degraded` gains `{ namespace }`.** Single call site
  (`hybridSearch`, `:231`), already has `namespace` in scope. This is the metric this
  proposal explicitly targets with a namespace label, per the brainstorm item; it stays
  the *only* namespace-labeled metric added here, bounding the cardinality risk to one
  counter whose events (embedding/vector-store outages) are inherently rare.
- **No new config.** All three metrics route through the existing
  `observability.metrics_enabled` gate that `MetricsCollector`'s constructor already
  checks (`:74-76`) and every write method already short-circuits on (`:79`, `:85`,
  `:96`); no new Zod schema, no new env var.
- **Histogram "buckets" are not fixed-range.** This collector stores raw samples in a
  bounded circular buffer (`BoundedBuffer`, `:21-46`) and computes percentiles directly
  (`computePercentile`, `:10-18`), unlike a traditional Prometheus histogram with
  pre-declared bucket boundaries. `search_result_score` is therefore scale-agnostic per
  `mode` label regardless of whether cosine (semantic, ~0–1), RRF (hybrid, ~0.03), or
  composite-ranked (multiplied by the `add-composite-recall-ranking` prior) — no bucket
  tuning is needed.

## Risks / Trade-offs

- **Namespace cardinality.** `search_embedding_degraded{namespace="..."}` grows one
  series per distinct namespace ever seen. Mitigated by scope (only this one counter
  carries the label) and by the fact that degraded events are outage-driven and rare;
  not solved generally — the same unbounded-namespace-label question would apply to any
  future per-namespace metric and is left for a dedicated change if it becomes a
  problem.
- **`search_embedding_degraded` changes shape**, from one global series to one per
  namespace. It has never appeared in README (`grep` confirms no prior documentation
  or external contract), so this is additive/first-documentation, not a breaking change
  for any documented consumer — but any operator who was already scraping the
  undocumented unlabeled series will see it disappear and be replaced by labeled
  series, and must adjust (e.g. `sum by ()` to recover the old global total).
- **`incCounter` signature change** is additive (new optional third parameter) and
  every existing call site is unaffected in behavior; the only required code change
  beyond the two new metrics is updating the one existing assertion that pins the old
  unlabeled `search_embedding_degraded` call shape (`src/search/index.test.ts:346`).
- **Two new histogram families per search mode** (six total: count + score × 3 modes)
  add to the in-process bounded-buffer memory footprint — bounded at 1000 samples ×
  6 buffers, the same order of magnitude as the existing `bhgbrain_tool_handler_ms`
  per-tool-per-status buffers, so no capacity concern.
