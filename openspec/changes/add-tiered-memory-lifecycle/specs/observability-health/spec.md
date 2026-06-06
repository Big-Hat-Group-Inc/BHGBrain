## MODIFIED Requirements

### Requirement: Health reporting SHALL expose lifecycle capacity and drift signals
The system SHALL report retention-specific health signals including tier budgets, expiring-memory backlog, cleanup lag, and SQLite/Qdrant lifecycle drift.

#### Scenario: Tier budget pressure is surfaced
- **WHEN** active memory counts approach or exceed configured tier or total capacity thresholds
- **THEN** health output indicates a warning or degraded state with capacity details

#### Scenario: Lifecycle drift is surfaced
- **WHEN** retention metadata in SQLite and indexed lifecycle payloads in Qdrant diverge
- **THEN** health output reports degraded lifecycle status

### Requirement: Observability SHALL include lifecycle metrics and audit signals
The system SHALL emit retention-specific metrics and structured audit events for lifecycle transitions and cleanup execution.

#### Scenario: Cleanup emits metrics
- **WHEN** a cleanup run completes
- **THEN** metrics include duration, deleted count, archived count, and compaction activity

#### Scenario: Tier transitions emit audit events
- **WHEN** a memory is promoted, restored, archived, revised, or deleted
- **THEN** a structured event records the memory identifier, prior tier, new tier when applicable, actor, and timestamp

## ADDED Requirements

### Requirement: Cleanup execution SHALL emit retention metrics on every run

The system SHALL emit retention metrics from the cleanup execution path so that GC duration, deleted count, archived count, and compaction activity are observable without inspecting return values.

#### Scenario: Manual and scheduled GC record metrics

- **WHEN** a cleanup run completes via `bhgbrain gc` or the scheduled job
- **THEN** the system records GC duration as a histogram metric
- **AND** increments counters for deleted and archived memory counts
- **AND** records compaction activity when compaction runs

### Requirement: Lifecycle transitions SHALL emit structured audit events distinct from generic write codes

The system SHALL emit lifecycle-specific audit events for promotion, archival, revision, deletion, and restore rather than reusing the generic `ADD`/`UPDATE`/`FORGET` codes.

#### Scenario: Promotion emits a distinct lifecycle event

- **WHEN** a retrieval path promotes a memory by one tier
- **THEN** a structured lifecycle event records the prior tier, new tier, actor, and timestamp
- **AND** the event is distinguishable from a generic content update

#### Scenario: Cleanup failure surfaces degraded health

- **WHEN** an archival, delete, or compaction step fails during cleanup
- **THEN** the system surfaces a degraded retention health state
- **AND** preserves recoverable active metadata instead of dropping records silently
