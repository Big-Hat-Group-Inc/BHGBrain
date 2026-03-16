## ADDED Requirements

### Requirement: Retention GC must batch persistence work
Retention cleanup SHALL avoid full SQLite flush and audit persistence on every deleted memory.

#### Scenario: Many expired memories are cleaned in one pass
- **WHEN** GC processes a large expired set
- **THEN** SQLite persistence work is grouped into bounded batches or a single pass-level flush
- **THEN** cleanup latency is not dominated by per-memory full-database writes

### Requirement: Retention GC must preserve failure visibility
Retention cleanup SHALL surface partial cleanup failures explicitly.

#### Scenario: Vector delete fails during GC
- **WHEN** vector deletion fails for one or more expired memories
- **THEN** GC reports the failure as degraded or failed work
- **THEN** operators can identify which cleanup work remains unreconciled
