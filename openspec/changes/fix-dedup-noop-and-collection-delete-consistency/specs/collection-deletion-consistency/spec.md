## ADDED Requirements

### Requirement: Collection delete is consistency-preserving
Collection deletion SHALL NOT leave orphaned data across collection metadata, SQLite memories, and Qdrant vectors.

#### Scenario: Delete empty collection
- **WHEN** a delete request targets an existing empty collection
- **THEN** the collection metadata is removed
- **THEN** the operation succeeds without residual collection artifacts

#### Scenario: Delete non-empty collection without force
- **WHEN** a delete request targets a non-empty collection and force is not enabled
- **THEN** the operation fails with `CONFLICT`
- **THEN** no metadata, memory rows, or vectors are removed

#### Scenario: Force delete non-empty collection
- **WHEN** a delete request targets a non-empty collection and force is enabled
- **THEN** all SQLite memory rows for that namespace and collection are removed
- **THEN** the corresponding Qdrant collection vectors are removed
- **THEN** collection metadata is removed after data deletion completes

### Requirement: Collection delete reports deterministic outcomes
Collection deletion responses SHALL include deterministic deletion outcomes for operator visibility.

#### Scenario: Force delete response
- **WHEN** a forced deletion succeeds
- **THEN** the response includes the collection name and deleted memory count
