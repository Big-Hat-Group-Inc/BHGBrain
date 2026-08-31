## ADDED Requirements

### Requirement: Degraded writes must be logged and metered

When an embedding failure causes the write pipeline to fall back to a degraded (metadata-only, unsynced) write, the system SHALL emit a structured Pino warning log and SHALL increment a degraded-write metric so operators can observe that the deployment has entered degraded mode.

#### Scenario: Embedding failure triggers a degraded-write fallback

- **WHEN** the embedding provider fails for a write and degraded fallback is enabled
- **AND** the pipeline persists a metadata-only unsynced memory instead of throwing
- **THEN** a structured Pino warning is emitted including the event name, namespace, collection, and the embedding error
- **AND** a degraded-write metric (e.g. `degraded_writes_total`) is incremented
- **AND** the degraded condition is never swallowed without any log or metric

### Requirement: Degraded embedding startup must emit a warning

When the server starts with the embedding provider resolved to a degraded provider (for example because credentials are missing), the system SHALL emit a structured Pino warning at startup, consistent with the project's "no silent degradation" rule.

#### Scenario: Server starts in a degraded embedding mode

- **WHEN** the embedding provider factory returns the degraded provider at startup
- **AND** the server proceeds to accept requests
- **THEN** a structured Pino warning is emitted at startup including the event name, provider, and the reason for degradation
- **AND** the degraded startup is not left silent until a later request-time or health-check failure

### Requirement: Retention and GC runs must log a structured summary

When a retention or garbage-collection run executes, the system SHALL emit a structured Pino summary log reporting the run's counts and outcome, so persistent-state mutations are observable in logs.

#### Scenario: A retention/GC run mutates persistent state

- **WHEN** a retention or GC run marks memories stale, archives, or deletes records
- **THEN** a structured Pino summary log is emitted reporting the relevant counts (such as stale-marked, scanned, archived, deleted) and the run outcome
- **AND** the run is not left invisible in operational logs even though SQLite audit-log rows are written
