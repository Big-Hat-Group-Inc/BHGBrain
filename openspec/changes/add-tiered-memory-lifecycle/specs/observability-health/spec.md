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
