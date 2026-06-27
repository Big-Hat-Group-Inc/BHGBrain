## Context

The `add-percentile-metrics` change is complete and faithful to its proposal: `computePercentile`, p50/p95/p99 emission, and instrumentation at four named call sites. A follow-up audit (`codeaudit/add-percentile-metrics-2026-06-05-02-19.md`) surfaced three net-new gaps that this change addresses, all centered on the tool-handler latency metric and the `/metrics` serializer:

- `handleTool` (`src/tools/index.ts`) records `bhgbrain_tool_handler_ms` only inside the success branch (`:58`); the `catch` block computes `duration` for logging (`:62`) but never records it. By contrast, `search_total_ms` (`src/search/index.ts:52`) and `embedding_embed_batch_ms` (`src/embedding/index.ts:52`) record in a `finally` and therefore include failures.
- The original task 2.3 asked for per-tool identification (label or per-tool metric name); a single label-less metric was shipped for all tools.
- The `/metrics` serializer (`src/transport/http.ts:63`) drops `m.labels` and emits no `# TYPE` lines, so labeled metrics cannot be expressed. The `MetricEntry` type already carries an optional `labels` field (`src/health/metrics.ts:7`).

These interact: the per-tool fix is cleanest as a `tool` label, but a label-based metric is only observable once the serializer renders labels. Hence the three items are bundled into one coherent change.

## Goals / Non-Goals

**Goals**
- Tool-handler latency is recorded on every path — success and failure — so p95/p99 include the slow failure tail.
- Tool-handler latency is attributable to a specific tool (by name/label) in `/metrics`.
- The `/metrics` serializer renders labels and `# TYPE` metadata, unblocking per-tool naming and aligning with Prometheus scrapers.

**Non-Goals**
- No change to the percentile math (`computePercentile`) or the bounded-buffer histogram model.
- No new metrics dependency (no t-digest/DDSketch) — consistent with the percentile design's non-goal.
- No change to HTTP auth, loopback gating, or the `metrics_enabled` gate.
- No change to the four already-correct call sites (`search`, `embedding`) beyond confirming the shared pattern.

## Decisions

1. **Record in `finally`.** Move the `recordHistogram` call out of the success branch into a `finally` block in `handleTool`, capturing `duration = Date.now() - start` once. This is the same pattern as `search_total_ms`/`embedding_embed_batch_ms` and guarantees both `BrainError` and unexpected-error paths are sampled. Logging stays where it is; only the histogram record moves.

2. **Per-tool identification via a `tool` label.** Prefer `labels: { tool: toolName }` on a single `bhgbrain_tool_handler_ms` metric over per-tool metric names, because it keeps one metric family (simpler aggregation and discovery) and reuses the existing `MetricEntry.labels` field. A per-tool name (`bhgbrain_tool_${toolName}_ms`) is an acceptable fallback if the serializer/label work is deferred, but the label approach is the primary decision. Optionally a `status` label (ok/error) preserves the success/failure split without losing either from the latency histogram.

3. **Serializer emits labels and `# TYPE`.** Render labeled metrics as `name{k="v",...} value` (with label-value escaping) and emit one `# TYPE <name> <type>` line per family. Align the `_count` typing in `getMetrics` so its emitted type is correct within the histogram family. Output remains additive — existing unlabeled lines are unaffected.

## Risks / Trade-offs

- **Histogram cardinality per tool.** A `tool` label multiplies stored buffers by the number of distinct tools (bounded set of ~12 registered tools), so memory growth is small and bounded. A `status` label at most doubles that. Acceptable.
- **Serializer output shape change.** Adding `# TYPE` lines and label syntax changes the exact bytes returned by `/metrics`. Consumers parsing the old strict `name value` form could be affected; mitigated by keeping the `name value` form for unlabeled metrics and only adding label braces when labels exist. A serializer test pins the new shape.
- **Including failures shifts percentiles upward.** This is the intended correction — dashboards/alerts calibrated against the (artificially low) success-only tail may need re-baselining. Called out so operators expect the shift.

## Migration Plan

- Purely additive at the data layer; no persisted state or schema changes. No backfill.
- Existing `/metrics` consumers that read unlabeled lines continue to work; labeled per-tool lines and `# TYPE` lines are new additions.
- Roll out in a single change; no feature flag needed beyond the existing `observability.metrics_enabled` gate. Operators should expect tool-handler p95/p99 to rise once failures are included.

## Open Questions

1. Label (`tool`) vs. per-tool metric name — confirm the label approach is acceptable given the serializer change ships in the same PR.
2. Should a `status` (ok/error) label be added now, or is the latency-only fix sufficient for the immediate observability gap?
3. Should `# HELP` lines also be emitted, or is `# TYPE` sufficient for the target scrapers (audit Finding 3 mentioned both)?
