## Context

`MetricsCollector` uses a `BoundedBuffer` (capacity 1000) as a circular buffer for histograms. The buffer stores raw values, making percentile computation straightforward: sort a copy of `buf.values()` and index into the result. There is no need for a streaming approximation (like t-digest or DDSketch) at this scale.

Current output for a histogram named `search_latency_ms`:
```
search_latency_ms_avg 45.3
search_latency_ms_count 87
```

Target output:
```
search_latency_ms_avg 45.3
search_latency_ms_p50 38.1
search_latency_ms_p95 112.4
search_latency_ms_p99 201.7
search_latency_ms_count 87
```

## Goals / Non-Goals

**Goals:**
- Emit p50, p95, p99 for each histogram at zero additional memory cost (values are already stored in the buffer).
- Document which operations are instrumented and what metric names they use.
- Keep output format compatible with Prometheus-style scrapers (plain text, one metric per line).

**Non-Goals:**
- Streaming/approximate percentile algorithms (not needed at buffer capacity 1000).
- Histograms with configurable bucket boundaries (future, if Prometheus native histogram format is needed).
- Changing the buffer capacity (1000 samples is sufficient for the expected operation volume).

## Decisions

### Decision: Sort a copy, not in-place

**Why:** `BoundedBuffer.values()` returns a new array already (spread copy). Sorting that array in `computePercentile` is safe and does not mutate the buffer. No additional defensive copy needed.

### Decision: Emit p50, p95, p99 — not p75 or p99.9

**Why:** p50 (median) gives the typical-case view, p95 is the standard SLO threshold, p99 catches the worst-case tail. Adding more percentiles is additive and can be done later. p99.9 requires a larger sample size to be meaningful.

### Decision: Instrument at the call site, not in middleware

**Why:** Latency attribution matters. A single `/tool/:name` request may span SQLite + Qdrant + embedding. Instrumenting each individually makes it possible to isolate which layer is slow. A single "request duration" metric obscures this.

**Proposed instrumentation points:**
- `src/embedding/index.ts` → `embedding_embed_ms`, `embedding_embed_batch_ms`
- `src/search/index.ts` → `search_hydrate_ms`, `search_total_ms`
- `src/storage/sqlite.ts` (or storage manager) → `sqlite_query_ms` for expensive queries
- `src/tools/index.ts` → `tool_handler_ms` per tool name (label: tool name)

## Risks / Trade-offs

- **[Risk] Sort cost per `getMetrics` call for large buffers** → Mitigation: buffer capacity is 1000; sorting 1000 numbers is < 1ms. `getMetrics` is only called on `/metrics` requests, not on every operation.
- **[Risk] New metric names break existing dashboards** → Mitigation: changes are additive. Existing `_avg` and `_count` names are preserved.
