## ADDED Requirements

### Requirement: Collection deletion must not silently orphan vectors
The system SHALL NOT report successful collection cleanup when Qdrant deletion fails for reasons other than collection absence. When vector cleanup fails for a non-not-found reason, the system SHALL preserve SQLite rows AND record an explicit, detectable reconciliation signal — a narrow tombstone or affected rows marked not `vector_synced` — and emit a health/log signal so the residual drift is observable and retryable rather than appearing as zero drift.

#### Scenario: Qdrant transient error during collection delete
- **WHEN** forced collection deletion removes SQLite rows and Qdrant returns a transient error
- **THEN** the operation returns an explicit failure or degraded result
- **THEN** reconciliation data remains available for retry

#### Scenario: Failed vector cleanup leaves a detectable tombstone
- **WHEN** forced collection deletion encounters a non-not-found Qdrant error so the collection's vectors may be partially deleted or orphaned
- **THEN** the surviving SQLite rows (or a narrow tombstone) record the failure rather than remaining `vector_synced = true`
- **AND** a health/log drift signal is emitted so the orphaned vectors are visible to reconciliation reporting (`unsynced_vectors` / `checkVectorReconciliation`)
- **AND** the failed cleanup remains retryable from the recorded reconciliation state

### Requirement: Not-found vector cleanup may be treated as already clean
The system MAY treat missing Qdrant collections as already deleted.

#### Scenario: Qdrant collection is already absent
- **WHEN** collection cleanup targets a collection that no longer exists in Qdrant
- **THEN** the vector cleanup step is treated as idempotently complete
