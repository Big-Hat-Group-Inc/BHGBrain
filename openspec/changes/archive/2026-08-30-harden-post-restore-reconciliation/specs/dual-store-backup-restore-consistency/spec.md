## ADDED Requirements

### Requirement: Post-activation vector recovery failures SHALL preserve activated state
When a restore has already activated restored SQLite state in the running process, later vector cleanup or reconciliation failures SHALL be surfaced as explicit degraded vector readiness instead of negating metadata activation.

#### Scenario: Vector cleanup fails after SQLite activation
- **WHEN** a restore successfully activates restored SQLite state and subsequent vector clearing or rebuild work fails
- **THEN** the restore result reports metadata activation success
- **AND** the result reports vector reconciliation as pending or degraded
- **AND** semantic health does not report the service as fully ready until vector recovery completes

### Requirement: Reconciliation progress SHALL remain durable across partial failure
The system SHALL persist successful post-restore reconciliation progress before returning a pending reconciliation outcome from a later failure in the same run.

#### Scenario: Reconciliation fails after some restored memories are rebuilt
- **WHEN** post-restore reconciliation successfully re-upserts a subset of restored memories and a later memory in the same run fails
- **THEN** successfully rebuilt memories remain marked as synced
- **AND** only the remaining unreconciled memories stay pending vector recovery
- **AND** a subsequent reconciliation run resumes from the remaining unsynced set
