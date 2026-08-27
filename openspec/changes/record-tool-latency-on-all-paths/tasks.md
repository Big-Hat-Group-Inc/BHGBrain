## 1. Record tool-handler latency on all paths

- [x] 1.1 In `src/tools/index.ts` `handleTool`, hoist `duration` and move the `recordHistogram` call out of the `try` success branch (`:58`) into a `finally` block so latency is recorded for both success and failure, capturing `Date.now() - start` exactly once.
- [x] 1.2 Verify the `finally` records even when `dispatch` throws a `BrainError` (handled at `:63`) and when it throws an unexpected error (handled at `:67`), without altering the existing return values or log events.
- [x] 1.3 Confirm the recording pattern matches the existing `finally`-based instrumentation in `src/search/index.ts:52` and `src/embedding/index.ts:52`.

## 2. Identify tool-handler latency per tool

- [x] 2.1 Add per-tool identification to the tool-handler histogram — either a `labels: { tool: toolName }` dimension on `bhgbrain_tool_handler_ms` (the `MetricEntry` type already supports `labels` in `src/health/metrics.ts:7`) or a per-tool metric name (e.g. `bhgbrain_tool_${toolName}_ms`). Pick one approach and apply it consistently.
- [x] 2.2 Optionally tag a success/error status (label or separate counter) so the success/failure split is preserved while still recording both in the latency histogram.
- [x] 2.3 Ensure `MetricsCollector.recordHistogram` / `getMetrics` carries the chosen per-tool identification through to `getMetrics` output without dropping it.

## 3. Render labels and types in the `/metrics` serializer

- [x] 3.1 Update the `/metrics` serializer in `src/transport/http.ts:63` to render `m.labels` in Prometheus form: `name{k="v",...} value` (escaping label values), instead of `${m.name} ${m.value}`.
- [x] 3.2 Emit a `# TYPE <name> <counter|gauge|histogram>` line once per metric family.
- [x] 3.3 Align the `_count` entry typing in `src/health/metrics.ts:97` with the histogram family so the emitted `# TYPE` is correct for histogram `_count`. (Already `'counter'`, which is the correct Prometheus type for a cumulative sample count within a histogram family — verified this renders correctly once labels/TYPE lines flow through the serializer; comment added in code to make the intent explicit.)
- [x] 3.4 Keep the output additive/backward-compatible: existing `_avg`/`_p50`/`_p95`/`_p99`/`_count` lines remain present.

## 4. Tests

- [x] 4.1 Add a test that a failing tool dispatch (throws) still records a tool-handler latency sample (failure path is included in the histogram).
- [x] 4.2 Add a test asserting per-tool identification is present (label or per-tool name) so two different tools produce distinguishable latency entries.
- [x] 4.3 Add a `/metrics` serializer test asserting that `labels` render as `name{...} value` and that `# TYPE` lines are emitted.

## 5. Docs

- [x] 5.1 Update `README.md` observability section if it documents tool-handler metric names/labels. (Mirrored to README.de.md, README.es.md, README.fr.md, README.zh-CN.md; also fixed pre-existing drift in the translations, which still documented a `bhgbrain_tool_duration_seconds_*` metric name that no longer exists.)

## 6. Validation

- [x] 6.1 Run `npm run lint`, `npm test`, and `npm run build`.
