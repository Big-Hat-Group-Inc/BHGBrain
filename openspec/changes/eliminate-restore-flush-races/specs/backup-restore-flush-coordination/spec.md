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
