## ADDED Requirements

### Requirement: Retention processing SHALL mark stale memories without age-based hard delete
The system SHALL mark memories as stale after configured inactivity windows and SHALL not hard-delete memories solely based on age in v1.

#### Scenario: Inactive low-importance memory is marked stale
- **WHEN** retention processing evaluates a memory older than configured decay threshold
- **THEN** the memory is flagged stale and remains retrievable

#### Scenario: Category memories are excluded from decay
- **WHEN** retention processing evaluates category entries
- **THEN** category entries are not flagged stale by age-based decay rules

### Requirement: Consolidation SHALL detect merge clusters and contradictions
Consolidation runs SHALL detect low-importance stale clusters and contradiction candidates while preserving traceability of decisions.

#### Scenario: Similar stale cluster is surfaced for merge handling
- **WHEN** three or more stale memories exceed cluster similarity thresholds
- **THEN** the run reports the cluster as a consolidation candidate

#### Scenario: Prior delete decisions generate contradiction candidates
- **WHEN** consolidation analyzes historical delete/correction events
- **THEN** potential contradictions are surfaced for review

### Requirement: Runtime failures SHALL map to explicit degraded behaviors
The system SHALL provide deterministic degraded behavior for embedding, Qdrant, extraction-model, and SQLite-lock failures.

#### Scenario: Embedding outage blocks writes and keeps reads available
- **WHEN** embedding provider is unavailable
- **THEN** writes fail with `EMBEDDING_UNAVAILABLE` and read paths continue

#### Scenario: Qdrant outage falls back to fulltext search
- **WHEN** vector index is unavailable
- **THEN** search falls back to SQLite fulltext behavior with degraded semantics

#### Scenario: SQLite lock retries before internal failure
- **WHEN** a SQLite lock occurs during an operation
- **THEN** the system retries with exponential backoff before returning `INTERNAL` on exhaustion

## MODIFIED Requirements

### Requirement: Consolidation SHALL detect merge clusters and contradictions
Consolidation runs SHALL detect low-importance stale clusters and contradiction candidates while preserving traceability of decisions. This requirement SHALL be considered satisfied only when both scenarios below are implemented and tested; if the capability is not implemented it SHALL be explicitly removed from the proposal and this spec rather than left asserted-but-absent.

#### Scenario: Similar stale cluster is surfaced for merge handling
- **WHEN** three or more stale memories exceed cluster similarity thresholds
- **THEN** the run reports the cluster as a consolidation candidate

#### Scenario: Prior delete decisions generate contradiction candidates
- **WHEN** consolidation analyzes historical delete/correction events
- **THEN** potential contradictions are surfaced for review

#### Scenario: Unimplemented consolidation is de-scoped rather than silently asserted
- **WHEN** cluster and contradiction detection are not implemented
- **THEN** this requirement and its corresponding tasks are removed or marked out-of-scope in the change artifacts
- **AND** no scenario claims coverage that the implementation does not provide

### Requirement: Runtime failures SHALL map to explicit degraded behaviors
The system SHALL provide deterministic degraded behavior for embedding, Qdrant, extraction-model, and SQLite-lock failures. The SQLite-lock retry behavior SHALL be backed by an actual retry-with-backoff wrapper around write transactions keyed on busy/locked errors; if the underlying store is in-process sql.js with no OS-level lock, the spec SHALL document the retry scenario as an intentional no-op rather than asserting an unimplemented contract.

#### Scenario: Embedding outage blocks writes and keeps reads available
- **WHEN** embedding provider is unavailable
- **THEN** writes fail with `EMBEDDING_UNAVAILABLE` and read paths continue

#### Scenario: Qdrant outage falls back to fulltext search
- **WHEN** vector index is unavailable
- **THEN** search falls back to SQLite fulltext behavior with degraded semantics

#### Scenario: SQLite lock retries before internal failure
- **WHEN** a SQLite lock occurs during an operation
- **THEN** the system retries with exponential backoff before returning `INTERNAL` on exhaustion

#### Scenario: In-process store documents retry as no-op
- **WHEN** the active SQLite driver is in-process sql.js with no OS-level locking
- **THEN** the retry-with-backoff scenario is documented as a no-op by design and no retry path is falsely claimed as implemented
