## ADDED Requirements

### Requirement: Restore activation must coordinate deferred persistence state
The system SHALL cancel or otherwise neutralize deferred SQLite flush work before runtime restore activation completes.

#### Scenario: Pending deferred flush exists during restore
- **WHEN** a backup restore begins while a deferred flush timer is pending
- **THEN** the pending flush does not write stale pre-restore state after activation
- **THEN** subsequent reads observe the restored dataset

### Requirement: Restore must serialize runtime persistence activity
The system SHALL prevent concurrent persistence work from overlapping with runtime restore activation.

#### Scenario: Mutation arrives during restore
- **WHEN** a mutating operation arrives while restore activation is in progress
- **THEN** the operation is rejected or deferred by explicit lifecycle policy
- **THEN** restored runtime state remains internally consistent

## MODIFIED Requirements

### Requirement: Restore must serialize runtime persistence activity
The system SHALL prevent concurrent persistence work from overlapping with runtime restore activation. This guarantee SHALL apply to **all** state-mutating storage operations, including retention- and consolidation-driven mutations such as `markStale` and `archiveMemory`, which SHALL be subject to the same lifecycle guard as ordinary mutations. No state-mutating path may set the dirty flag or schedule deferred flush work while the lifecycle lock is held, except via an explicitly documented opt-out.

#### Scenario: Mutation arrives during restore
- **WHEN** a mutating operation arrives while restore activation is in progress
- **THEN** the operation is rejected or deferred by explicit lifecycle policy
- **AND** the same policy applies whether the mutation is client-initiated or system/retention-initiated
- **THEN** restored runtime state remains internally consistent

#### Scenario: Retention markStale races a restore activation
- **WHEN** a restore is in progress and holds the lifecycle lock
- **AND** the retention engine invokes `markStale` or `archiveMemory` during the restore activation window
- **THEN** the retention mutation is rejected or deferred by the same lifecycle policy as a client mutation
- **AND** the retention mutation does not mark the in-memory database dirty or schedule deferred flush work against pre-restore state
- **THEN** after activation completes, the restored dataset is not contaminated by the retention write
