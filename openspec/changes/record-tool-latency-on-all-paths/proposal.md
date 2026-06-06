## Why

The `add-percentile-metrics` change added p50/p95/p99 latency percentiles precisely so operators could see the slow tail that a fast average masks. A code audit of that completed change (`codeaudit/add-percentile-metrics-2026-06-05-02-19.md`) found three net-new gaps that undermine that goal:

1. **The failure tail is excluded.** `handleTool` in `src/tools/index.ts:58` records `bhgbrain_tool_handler_ms` only on the success path. The `catch` branch (`:62`) computes the duration for logging but never records it to the histogram. Failures — timeouts, circuit-breaker opens, an unreachable embedding provider — are frequently the *slowest* requests, so excluding them biases p95/p99 downward exactly where the signal matters. This is inconsistent with `search_total_ms` and `embedding_embed_batch_ms`, which correctly record in a `finally` (`src/search/index.ts:52`, `src/embedding/index.ts:52`).

2. **Spec drift from the original task 2.3.** A single label-less `bhgbrain_tool_handler_ms` was implemented for all tools instead of the required per-tool identification (label or per-tool metric name). You cannot tell from `/metrics` which tool is slow, defeating per-layer latency attribution.

3. **The `/metrics` serializer cannot express labels or types.** `src/transport/http.ts:63` maps each metric to `${m.name} ${m.value}`, dropping `m.labels` entirely and emitting no Prometheus `# TYPE` lines. This both flattens any future label-based metric (so multiple tools would collide on one line) and blocks the cleanest fix for the per-tool naming drift.

## What Changes

- Record tool-handler latency on **both** success and failure paths by moving the `recordHistogram` call into a `finally` block in `handleTool`, capturing the duration once. This restores the failure tail to the tool-handler percentiles.
- Identify tool-handler latency **per tool** (by tool name/label) so `/metrics` attributes latency to a specific tool, resolving the original task 2.3 drift.
- Update the `/metrics` plain-text serializer to **emit `labels`** (Prometheus `name{k="v",...} value` form) and **emit `# TYPE` lines** per metric family, so labeled per-tool metrics render correctly and scrapers can type the output.
- Add/extend tests asserting: failures are recorded in the tool-handler histogram, per-tool identification is present, and the serializer renders labels and `# TYPE` lines.

## Capabilities

### New Capabilities
- `complete-latency-instrumentation`: Tool-handler latency is recorded on every code path (success and failure), identified per tool, and rendered by the `/metrics` serializer with labels and Prometheus `# TYPE` metadata.

### Modified Capabilities

(none)

## Impact

- **Code:** `src/tools/index.ts` (move latency recording into `finally`, add per-tool identification), `src/transport/http.ts` (serializer emits labels + `# TYPE`), and possibly `src/health/metrics.ts` (consistent `_count`/family typing once `# TYPE` is emitted).
- **Observability:** p95/p99 for tool handlers now reflect slow failures; per-tool latency becomes attributable in `/metrics`; output becomes Prometheus-scrapeable with labels and types. The change is additive to the metric surface and backward-compatible for the existing label-less consumers in the common case.
- **Tests:** new assertions in `src/tools/index.test.ts` (or equivalent) and a `/metrics` serializer test.
- **Docs:** `README.md` observability section if metric names/labels are documented.
