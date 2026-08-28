## ADDED Requirements

### Requirement: Audit log growth SHALL be bounded by a configurable cap
The audit log SHALL be pruned to a configured maximum entry count during scheduled
cleanup, keeping the newest entries, with `null` disabling pruning entirely.

#### Scenario: Cap enforced during GC
- **WHEN** a cleanup (GC) run executes and the audit log exceeds
  `retention.audit_log_max_entries`
- **THEN** the oldest entries beyond the cap SHALL be deleted
- **AND** the newest entries up to the cap SHALL be preserved in timestamp order
- **AND** the number pruned SHALL appear in the GC result and log event

#### Scenario: Pruning disabled
- **WHEN** `retention.audit_log_max_entries` is `null`
- **THEN** no audit entries SHALL ever be pruned

### Requirement: Memory revision history SHALL be bounded per memory
Each memory's revision history SHALL be pruned to a configured per-memory maximum
during scheduled cleanup, keeping the highest revision numbers, with `null` disabling
pruning entirely.

#### Scenario: Per-memory cap enforced
- **WHEN** a cleanup run executes and a memory has more revisions than
  `retention.revisions_per_memory_max`
- **THEN** only the lowest-numbered surplus revisions of that memory SHALL be deleted
- **AND** revision listing for that memory SHALL remain correctly ordered afterwards

#### Scenario: Other memories unaffected
- **WHEN** revisions are pruned for one memory
- **THEN** revision rows belonging to other memories SHALL be untouched

### Requirement: Pruning SHALL respect the cleanup run's mode and reporting
History pruning SHALL run only inside the existing retention cleanup path and SHALL
honor its dry-run semantics.

#### Scenario: Dry run
- **WHEN** cleanup runs with `dryRun`
- **THEN** no audit entries or revisions SHALL be deleted

#### Scenario: Durable across restart
- **WHEN** pruning completes and the database is flushed and reloaded
- **THEN** the pruned state SHALL persist
