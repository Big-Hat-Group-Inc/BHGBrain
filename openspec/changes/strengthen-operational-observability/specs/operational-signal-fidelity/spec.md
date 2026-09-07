## Purpose

Defines bounded, correlated, and truthful logs, metrics, and health signals so operators can identify failures and capacity risks without telemetry becoming a resource risk itself.

## ADDED Requirements

### Requirement: Request activity SHALL be correlatable end to end
Each HTTP or MCP request SHALL carry a request or session identifier and trusted client identity through tool, storage, dependency, and error logs.

#### Scenario: Concurrent MCP calls fail in one dependency
- **WHEN** one of several concurrent sessions encounters a storage error
- **THEN** its tool and storage events share identifiers that distinguish it from other sessions

### Requirement: Metric cardinality SHALL be bounded
Metric families SHALL accept only bounded label domains, cap total series, publish dropped-series counts, and prevent arbitrary tool names or namespaces from allocating permanent series.

#### Scenario: Unknown REST tool names are requested repeatedly
- **WHEN** callers send many unique unknown tool paths
- **THEN** they are rejected before metric labels are allocated
- **AND** the metric registry remains within its configured cap

### Requirement: Tool metrics SHALL be monotonic and outcome-specific
Every tool completion SHALL increment a cumulative counter labeled by validated tool and success or error status; rolling histogram occupancy SHALL be exposed as a gauge rather than a cumulative count.

#### Scenario: A tool begins failing
- **WHEN** a tool returns classified errors
- **THEN** operators can derive its error rate from monotonic counters

### Requirement: Metrics availability SHALL be explicit
The default service SHALL expose instrumentation, or a disabled metrics endpoint SHALL return an explicit service-unavailable explanation and startup event instead of an unexplained 404.

#### Scenario: Metrics are disabled by configuration
- **WHEN** an operator probes the metrics path
- **THEN** the response identifies the disabling setting and does not imply the route is unknown

### Requirement: Error logs SHALL preserve structure and apply effective redaction
Logs SHALL serialize error type, message, stack, and cause under one field convention; include service and version base fields; route CLI logs to stderr; and redact fields that are actually emitted and may contain secrets or untrusted content.

#### Scenario: Provider client throws a nested error
- **WHEN** a tool fails because a provider error has a cause and stack
- **THEN** the server log preserves diagnostic structure without exposing credentials or memory content

### Requirement: Health SHALL reflect documented capacity and background state
Health SHALL evaluate configured database-size and warning thresholds, scheduler state, both vector-drift directions, unresolved restore causes, and required dependency state.

#### Scenario: Database exceeds its warning threshold
- **WHEN** size or memory count crosses the configured warning percentage
- **THEN** health becomes degraded before the hard cap is exceeded

#### Scenario: Vector store contains surplus points
- **WHEN** vector point counts exceed authoritative SQLite records
- **THEN** health reports suspected orphan vectors rather than zero drift

### Requirement: Failure events SHALL use actionable severity and cause labels
Failed cleanup, reconciliation, and dependency operations SHALL be warn or error events with stable cause fields, while process-lifetime informational conditions SHALL not emit one warning per request.

#### Scenario: Default unauthenticated loopback mode serves traffic
- **WHEN** authentication is intentionally disabled for loopback use
- **THEN** the condition is logged once at startup rather than on every request
