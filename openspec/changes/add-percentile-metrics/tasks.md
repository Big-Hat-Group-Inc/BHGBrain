## 1. Add Percentile Computation to MetricsCollector

- [x] 1.1 Add `computePercentile(sortedValues: number[], p: number): number` as a module-level utility in `src/health/metrics.ts` — returns the value at the `p`th percentile (0–100) using nearest-rank method
- [x] 1.2 In `getMetrics`, for each histogram: sort a copy of `buf.values()`, then compute and emit p50, p95, p99 entries alongside the existing `_avg` and `_count`
- [x] 1.3 Emit percentile entries with names `${name}_p50`, `${name}_p95`, `${name}_p99` and type `'histogram'`
- [x] 1.4 Handle edge case: if `buf.values()` is empty, emit 0 for all percentiles (consistent with current avg behavior)

## 2. Instrument Key Latency Points

- [x] 2.1 In `src/embedding/index.ts`: wrap `embedBatch` fetch call with `Date.now()` delta and call `metrics.recordHistogram('embedding_embed_batch_ms', delta)` — requires passing `MetricsCollector` to the provider (via constructor or call-site injection)
- [x] 2.2 In `src/search/index.ts`: record `search_total_ms` from start of `search()` to return for each search mode
- [x] 2.3 In `src/tools/index.ts`: record `tool_handler_ms` with a label dimension or per-tool metric name (e.g., `tool_remember_ms`, `tool_recall_ms`) — choose the approach consistent with existing metric naming
- [x] 2.4 Confirm `MetricsCollector` is accessible from all instrumented call sites (already injected via `ToolContext`; verify embedding provider access path)

## 3. Update `/metrics` Endpoint Documentation

- [x] 3.1 Update inline comments in `src/transport/http.ts` metrics handler to note that histogram output now includes p50/p95/p99
- [x] 3.2 Update `README.md` observability section (if it documents metric names) to list the new percentile metric names

## 4. Tests

- [x] 4.1 In `src/health/metrics.test.ts` (from `expand-test-coverage`): add assertions that `getMetrics` emits `_p50`, `_p95`, `_p99` entries for a histogram with known values
- [x] 4.2 Assert `computePercentile` returns correct values for: empty array → 0, single value → that value, known distribution (e.g., [1..100] → p50=50, p95=95, p99=99)
- [x] 4.3 Assert histogram with capacity overflow (>1000 samples): percentile computation reflects only the most recent 1000 values

## 5. Commit

- [x] 5.1 Run `npm test` and confirm all tests pass
- [x] 5.2 Commit with message: `feat: add p50/p95/p99 percentile metrics to MetricsCollector (codereview2)`
- [x] 5.3 Push to active branch
