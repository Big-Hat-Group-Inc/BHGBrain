## ADDED Requirements

### Requirement: Retention GC must batch persistence work
Retention cleanup SHALL avoid full SQLite flush and audit persistence on every deleted memory.

#### Scenario: Many expired memories are cleaned in one pass
- **WHEN** GC processes a large expired set
- **THEN** SQLite persistence work is grouped into bounded batches or a single pass-level flush
- **THEN** cleanup latency is not dominated by per-memory full-database writes

## MODIFIED Requirements

### Requirement: Retention GC must preserve failure visibility
Retention cleanup SHALL surface partial or transient batch deletion failures explicitly as a degraded result carrying the set of unreconciled memory ids AND a health-visible drift signal. Batched GC SHALL NOT report a fully successful pass when vector cleanup failed for any memory, and SHALL NOT throw an opaque generic internal error in place of a degraded result. SQLite rows SHALL be removed only for memories whose vector deletion was confirmed; memories whose vectors could not be removed SHALL remain detectable as unreconciled drift (e.g. `vector_synced` not left `true`) so health reporting reflects the residual cleanup work.

#### Scenario: Vector delete fails during GC
- **WHEN** vector deletion fails for one or more expired memories
- **THEN** GC reports the failure as degraded or failed work
- **THEN** operators can identify which cleanup work remains unreconciled

#### Scenario: Transient Qdrant error mid-batch
- **WHEN** GC batches deletions by namespace/collection AND a transient Qdrant error occurs on one group after archive rows have been written
- **THEN** GC returns a degraded result carrying the unreconciled memory ids rather than throwing a generic internal error
- **AND** SQLite rows are removed only for the groups whose vectors were confirmed deleted
- **AND** the unreconciled memories remain visible as cross-store drift to health reporting (their `vector_synced` is not left `true`)
- **AND** the pass is not flushed as if it had fully succeeded
