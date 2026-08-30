## ADDED Requirements

### Requirement: Health endpoints SHALL report overall and component states
`GET /health` and `health://status` SHALL return overall status and individual component statuses for `sqlite`, `qdrant`, and `embedding`.

#### Scenario: Healthy system reports healthy states
- **WHEN** all core components are available
- **THEN** overall status is `healthy` and each component status is healthy

#### Scenario: Partial outage reports degraded state
- **WHEN** embedding is unavailable while storage components remain available
- **THEN** overall status is `degraded` with embedding marked unavailable

### Requirement: Structured logs SHALL include required fields with redaction
Runtime logs SHALL be structured JSON and SHALL include timestamp, level, event, duration, tool, namespace, error code, and client id while redacting tokens and content previews by default.

#### Scenario: Request logs include required fields
- **WHEN** a tool call is processed
- **THEN** emitted logs contain required structured fields

#### Scenario: Sensitive values are redacted
- **WHEN** logs include authorization or memory content-related metadata
- **THEN** bearer tokens and content previews are redacted

### Requirement: Metrics exposure SHALL be configurable
The server SHALL expose defined metrics only when metrics are enabled in configuration.

#### Scenario: Metrics disabled omits metric endpoint behavior
- **WHEN** metrics are disabled
- **THEN** no metrics emission surface is exposed

#### Scenario: Metrics enabled emits required counters and histograms
- **WHEN** metrics are enabled
- **THEN** defined operational and memory metrics are emitted
