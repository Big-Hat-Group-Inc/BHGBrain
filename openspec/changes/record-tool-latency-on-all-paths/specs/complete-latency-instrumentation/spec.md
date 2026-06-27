## ADDED Requirements

### Requirement: Tool-handler latency is recorded on both success and failure paths
The system SHALL record tool-handler latency for every tool invocation regardless of outcome. The latency sample MUST be recorded for successful dispatches and for failed dispatches alike, so that the tool-handler latency percentiles (p50/p95/p99) include the slow-failure tail. The recording SHALL occur in a `finally` block that captures the elapsed duration exactly once, consistent with the existing `search_total_ms` and `embedding_embed_batch_ms` instrumentation.

#### Scenario: Successful tool call records latency
- **WHEN** a tool dispatch completes successfully
- **THEN** a tool-handler latency sample is recorded to the histogram
- **AND** the sample reflects the elapsed time from handler start to completion

#### Scenario: Failing tool call records latency
- **WHEN** a tool dispatch throws an error (a `BrainError` or an unexpected error)
- **THEN** a tool-handler latency sample is still recorded to the histogram
- **AND** the existing error log event and error return value are unchanged

#### Scenario: Latency is captured exactly once
- **WHEN** a tool dispatch runs to completion or fails
- **THEN** exactly one tool-handler latency sample is recorded for that invocation
- **AND** the elapsed duration is computed a single time

### Requirement: Tool-handler latency is identified per tool
The system SHALL identify recorded tool-handler latency by the invoked tool, either through a label (e.g. `tool`) on the tool-handler metric or through a per-tool metric name. The `/metrics` output SHALL allow latency for one tool to be distinguished from latency for another tool.

#### Scenario: Two different tools produce distinguishable latency entries
- **WHEN** two different tools are invoked
- **THEN** their latency samples are attributable to their respective tool identities
- **AND** the entries are not collapsed into a single undifferentiated tool-handler metric

#### Scenario: Per-tool identification survives serialization
- **WHEN** `getMetrics` output is rendered for the `/metrics` endpoint
- **THEN** the per-tool identification (label or per-tool name) is present in the rendered output
- **AND** it is not silently dropped

### Requirement: The /metrics serializer emits labels and Prometheus type metadata
The `/metrics` serializer SHALL render metric labels in Prometheus form and SHALL emit a `# TYPE` line for each metric family. Labeled metrics MUST be rendered as `name{key="value",...} value` with label values escaped, and unlabeled metrics MUST continue to render as `name value`. The output SHALL remain additive and backward-compatible with the existing `_avg`/`_p50`/`_p95`/`_p99`/`_count` lines.

#### Scenario: Labeled metric renders with label braces
- **WHEN** a metric entry carries one or more labels
- **THEN** the serializer renders it as `name{key="value",...} value`
- **AND** label values are escaped

#### Scenario: Unlabeled metric renders without braces
- **WHEN** a metric entry carries no labels
- **THEN** the serializer renders it as `name value`

#### Scenario: TYPE lines are emitted per family
- **WHEN** the `/metrics` endpoint is served
- **THEN** a `# TYPE <name> <counter|gauge|histogram>` line is emitted for each metric family
- **AND** the histogram `_count` entry is typed consistently with its histogram family
