## ADDED Requirements

### Requirement: Persisted database images SHALL be crash-durable
Every write of the SQLite database file (and of backup archives) SHALL fsync the
written data before the atomic rename, and SHALL fsync the parent directory after the
rename on platforms that support it, so that a power loss or OS crash after a flush
cannot leave the target file truncated or empty.

#### Scenario: Flush survives power loss
- **WHEN** a flush completes and the host subsequently loses power
- **THEN** the on-disk `brain.db` SHALL contain either the previous complete image or
  the new complete image, never a truncated one

#### Scenario: Platform without directory fsync
- **WHEN** the process runs on Windows or a filesystem that rejects directory fsync
- **THEN** the file-data fsync SHALL still occur
- **AND** the directory fsync SHALL be skipped without error

### Requirement: Write paths SHALL coalesce flushes within a bounded window
Mutating operations (memory writes, updates, deletes, audit entries, tool-handler
metadata edits) SHALL persist via the deferred-flush scheduler rather than an inline
full-image flush, and the unflushed state SHALL be bounded both in time (the existing
deferred-flush interval, measured from the first unflushed mutation) and in count of
dirty mutations, beyond which a flush SHALL occur immediately.

#### Scenario: Burst of writes
- **WHEN** many memories are written in quick succession
- **THEN** the database file SHALL be rewritten once per deferred window (or per
  dirty-count bound), not once or more per mutation

#### Scenario: Dirty-count bound reached
- **WHEN** the number of mutations since the last flush reaches the configured cap
- **THEN** the store SHALL flush immediately instead of waiting for the timer

#### Scenario: Graceful shutdown
- **WHEN** the store is closed while a deferred flush is pending
- **THEN** close SHALL cancel the timer and flush the dirty state before the database
  handle is released

### Requirement: Consistency barriers SHALL keep inline flushes
Degraded writes where SQLite holds the only copy, rollback/repair paths, lifecycle
batch operations, backup create/restore, and close SHALL continue to flush inline
rather than defer.

#### Scenario: Degraded write with vector store unavailable
- **WHEN** a memory is persisted without its vector (or a vector-sync failure is
  recorded)
- **THEN** the SQLite state SHALL be flushed inline before the operation returns

### Requirement: Startup SHALL NOT rewrite an unchanged database
Initialization SHALL detect whether the database file is new or any schema migration
or DDL actually changed the database, and SHALL only write the file when a change
occurred.

#### Scenario: Boot of a current-schema store
- **WHEN** the server starts against an existing database already at the current
  schema
- **THEN** `brain.db` SHALL NOT be rewritten during initialization

#### Scenario: Boot applies a migration
- **WHEN** initialization creates a fresh database or applies a column migration
- **THEN** the resulting state SHALL be flushed to disk before init completes

### Requirement: Backup I/O SHALL be asynchronous and allocation-lean
Backup creation and restoration SHALL use asynchronous file I/O, write the archive's
header and database segments sequentially without concatenating them into a second
full-size buffer, and SHALL preserve the existing `.bhgb` archive format byte for
byte.

#### Scenario: Backup of a large store
- **WHEN** a backup is created
- **THEN** the event loop SHALL NOT block on a synchronous full-database write
- **AND** no additional whole-database-size contiguous buffer SHALL be allocated
  beyond the exported image

#### Scenario: Format compatibility
- **WHEN** an archive created before this change is restored after it (or vice versa)
- **THEN** restore SHALL succeed with identical header parsing and checksum
  verification
