## ADDED Requirements

### Requirement: Service can start in degraded embedding mode
Server startup SHALL support degraded mode when embedding credentials are unavailable, if configured fallback behavior exists.

#### Scenario: Missing embedding API key
- **WHEN** embedding provider credentials are absent
- **THEN** server starts with degraded embedding status instead of crashing
- **THEN** embedding-dependent operations return explicit dependency-unavailable errors at request time

### Requirement: Health checks avoid hot-path external embedding calls
Health endpoints SHALL avoid real embedding API calls on every request.

#### Scenario: Frequent health probe traffic
- **WHEN** health endpoint is polled repeatedly
- **THEN** responses use cached or lightweight dependency status and do not generate per-request embedding API calls
