## ADDED Requirements

### Requirement: Memory updates are cross-store consistent
Update operations that change vector-relevant fields SHALL maintain consistency between SQLite and Qdrant.

#### Scenario: Qdrant update fails during memory update
- **WHEN** SQLite mutation is attempted with a new vector and Qdrant upsert fails
- **THEN** the operation returns an explicit error
- **THEN** SQLite state is rolled back or never committed so stored metadata remains consistent with vector index state

### Requirement: Partial failure is observable
Cross-store update failures SHALL be surfaced to callers and logs with dependency context.

#### Scenario: Dependency outage during update
- **WHEN** vector index dependency is unavailable
- **THEN** caller receives a dependency/internal failure response rather than success
