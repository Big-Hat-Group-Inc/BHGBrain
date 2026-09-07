## 1. Correlated Structured Logging

- [ ] 1.1 Add service/version base fields and standard error serialization to the logger and verify nested cause and stack fields appear in captured failure logs.
- [ ] 1.2 Standardize exception records under `err`, nest arbitrary detail objects, and include BrainError message/retryability; verify stable event fields cannot be overwritten by caller data.
- [ ] 1.3 Route CLI logs to stderr and give CLI breakers stable keys/loggers; verify JSON command output on stdout remains clean and breaker transitions are labeled.
- [ ] 1.4 Replace inert redaction paths with emitted-field coverage and hashed token previews and verify secrets/content are absent from captured logs.
- [ ] 1.5 Add HTTP request IDs and MCP session/per-call IDs with trusted client identity propagation into child loggers; verify concurrent calls can be correlated end to end.
- [ ] 1.6 Log process-lifetime auth/config conditions once and elevate cleanup/dependency failures to warn or error; verify repeated normal requests do not produce warning noise.

## 2. Bounded Useful Metrics

- [ ] 2.1 Register metric descriptors with bounded label allowlists and a total-series cap and verify arbitrary tool/namespace inputs cannot grow the registry.
- [ ] 2.2 Add dropped-series and registry-size metrics plus bounded overflow behavior and verify saturation is visible without allocating new series.
- [ ] 2.3 Add monotonic per-tool success/error counters and correctly typed rolling histogram gauges/totals and verify error-rate queries remain meaningful after 1,000 samples.
- [ ] 2.4 Make metrics enabled by default or expose a stable disabled endpoint/startup event and verify operators never receive an unexplained metrics 404.

## 3. Health Fidelity

- [ ] 3.1 Implement database byte and memory-count warning thresholds and verify health degrades at configured percentages before hard capacity.
- [ ] 3.2 Add cached bidirectional SQLite/vector count and checksum signals and verify vector-only, missing-vector, and stale-payload cases are distinguishable.
- [ ] 3.3 Preserve distinct restore drift causes and scheduler failure state in health and verify transient vector reads are not mislabeled as model changes.
- [ ] 3.4 Update telemetry documentation/compatibility aliases and run logger, metric, health, transport, CLI, and retention tests plus `npm run lint`, `npm test`, and `npm run build`.
