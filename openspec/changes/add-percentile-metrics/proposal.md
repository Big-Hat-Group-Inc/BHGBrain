## Why

`MetricsCollector` in `src/health/metrics.ts` records histogram values in a bounded circular buffer but only computes and exposes `_avg` and `_count` per histogram. Average latency is a poor SLO signal: a fast average can mask a slow tail. Under real workloads — large memory payloads, Qdrant network variance, OpenAI embedding latency — p95 and p99 are the meaningful thresholds for detecting degradation before it becomes a user-visible outage.

codereview2.md explicitly calls this out under Operational Readiness: "Expand metrics collection for p95/p99 latency tracking."

## What Changes

- Extend `MetricsCollector.getMetrics` to emit `_p50`, `_p95`, and `_p99` entries for each histogram in addition to the existing `_avg` and `_count`.
- Add a `computePercentile(values: number[], p: number): number` utility (sorts a copy; no mutation of the buffer).
- Update the `/metrics` HTTP endpoint output to include the new metric names in the existing plain-text format.
- Expose `recordHistogram` call sites for latency-sensitive operations: embed calls, Qdrant search, SQLite queries, and tool handler round-trips.

## Capabilities

### New Capabilities
- `histogram-percentile-metrics`: `MetricsCollector` computes and emits p50/p95/p99 percentiles for all recorded histograms.

### Modified Capabilities
- `search-resource-consistency-and-observability`: Observability now includes latency percentiles, not just averages.

## Impact

- `src/health/metrics.ts` — Add percentile computation; update `getMetrics` output.
- `src/transport/http.ts` — `/metrics` output gains new lines; backward-compatible (additive only).
- `src/tools/index.ts`, `src/search/index.ts`, `src/embedding/index.ts` — Add `recordHistogram` call sites for key latency points if not already instrumented.
- No breaking changes. Consumers of `/metrics` receive additional lines.
