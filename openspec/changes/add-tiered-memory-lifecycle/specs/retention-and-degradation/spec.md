## MODIFIED Requirements

### Requirement: Retention processing SHALL enforce tier-based lifecycle rules
The system SHALL enforce tier-based lifecycle behavior for active memories. This replaces the prior stale-only model. Eligible `T2` and `T3` memories may be archived and deleted after configured inactivity windows, while `T0` is never deleted by retention policy and `T1` requires warning/review semantics before deletion eligibility.

#### Scenario: Inactive transient memory is deleted after archival
- **WHEN** retention processing evaluates a decay-eligible `T3` memory past its expiry policy
- **THEN** the memory is archived when archival is enabled
- **AND** removed from active SQLite and Qdrant stores

#### Scenario: Category memories remain excluded from deletion
- **WHEN** retention processing evaluates persistent category entries
- **THEN** category entries are excluded from tier-based deletion paths

### Requirement: Consolidation SHALL operate within tier policy boundaries
Consolidation runs SHALL detect merge clusters and contradiction candidates without bypassing lifecycle protections for protected tiers.

#### Scenario: Consolidation does not delete protected tiers
- **WHEN** consolidation evaluates `T0` or protected `T1` memories
- **THEN** it may surface candidates for review
- **AND** it does not delete them directly

### Requirement: Runtime failures SHALL map to explicit degraded behaviors
The system SHALL provide deterministic degraded behavior for embedding, Qdrant, extraction-model, cleanup execution, and SQLite-lock failures.

#### Scenario: Cleanup failure preserves active memories and reports degraded health
- **WHEN** archival, delete, or compaction steps fail during cleanup
- **THEN** the system preserves recoverable active metadata where needed
- **AND** surfaces a degraded health state instead of silently dropping records

#### Scenario: Qdrant lifecycle drift is reported
- **WHEN** SQLite lifecycle state and Qdrant payload state diverge beyond a tolerated threshold
- **THEN** health reporting indicates degraded retention status
