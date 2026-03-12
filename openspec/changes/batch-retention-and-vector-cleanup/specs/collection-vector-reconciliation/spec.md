## ADDED Requirements

### Requirement: Collection deletion must not silently orphan vectors
The system SHALL NOT report successful collection cleanup when Qdrant deletion fails for reasons other than collection absence.

#### Scenario: Qdrant transient error during collection delete
- **WHEN** forced collection deletion removes SQLite rows and Qdrant returns a transient error
- **THEN** the operation returns an explicit failure or degraded result
- **THEN** reconciliation data remains available for retry

### Requirement: Not-found vector cleanup may be treated as already clean
The system MAY treat missing Qdrant collections as already deleted.

#### Scenario: Qdrant collection is already absent
- **WHEN** collection cleanup targets a collection that no longer exists in Qdrant
- **THEN** the vector cleanup step is treated as idempotently complete
