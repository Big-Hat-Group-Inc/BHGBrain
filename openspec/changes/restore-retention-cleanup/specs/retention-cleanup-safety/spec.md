## Purpose

Defines reliable, bounded retention cleanup so expired data and capped history are reclaimed without blocking the cleanup operation itself or hiding incomplete work.

## ADDED Requirements

### Requirement: Cleanup SHALL mutate storage under explicit lifecycle ownership
A retention run SHALL be allowed to perform only the archive, delete, audit, pruning, state, and compaction mutations owned by that run while unrelated mutations remain excluded by the lifecycle operation.

#### Scenario: Scheduled cleanup owns the lifecycle operation
- **WHEN** scheduled cleanup acquires the retention lifecycle operation
- **THEN** its authorized mutations complete without being rejected by its own lock
- **AND** an unrelated write attempted during the destructive phase receives a retryable conflict

#### Scenario: Cleanup fails inside the lifecycle operation
- **WHEN** cleanup encounters an error while holding lifecycle ownership
- **THEN** the original failure remains the reported cause
- **AND** the degraded state is recorded after the operation can safely release or bypass its own guard

### Requirement: Cleanup SHALL process bounded resumable work
Each retention pass SHALL read and process expired memories in bounded pages, enforce a configured work or time budget, and expose whether eligible work remains.

#### Scenario: Expired population exceeds one pass
- **WHEN** eligible expired memories exceed the configured page or pass budget
- **THEN** cleanup processes bounded pages in deterministic order
- **AND** the result reports processed and remaining work so a later pass can resume

#### Scenario: Dry run encounters a large population
- **WHEN** a dry run examines more candidates than its response budget permits
- **THEN** it returns bounded counts and a continuation indication instead of serializing every memory

### Requirement: Scheduler configuration SHALL fail validation or health visibly
Retention and distillation schedules SHALL be validated before scheduling. A scheduler that cannot arm SHALL expose a failed state through health and logs.

#### Scenario: Invalid cron expression is configured
- **WHEN** configuration contains a malformed or unsatisfiable cron expression
- **THEN** configuration loading fails with the setting path and reason
- **AND** the service does not silently continue with an apparently running scheduler

### Requirement: Archival and history pruning SHALL be retry-safe
Archiving the same memory more than once SHALL converge to one current archive record, and future revision numbers SHALL remain greater than all retained revision numbers after pruning.

#### Scenario: Archived deletion is retried
- **WHEN** a prior run archived a memory but failed before deleting its active copy
- **THEN** a retry updates or reuses one archive record rather than appending a duplicate

#### Scenario: Revisions are pruned and memory is updated again
- **WHEN** old revisions have been pruned and a later T0 content update occurs
- **THEN** the new revision receives a number greater than the maximum retained revision

### Requirement: Cleanup dependency failures SHALL remain truthful
Cleanup SHALL preserve the actual cause of vector deletion and collection-inspection failures, SHALL NOT infer a zero point count from an inspection error, and SHALL log failed or degraded runs at warn or error severity.

#### Scenario: Collection statistics cannot be read
- **WHEN** vector collection inspection fails during a compaction decision
- **THEN** compaction for that collection is skipped and the cause is reported
- **AND** no deletion ratio is fabricated from a zero default
