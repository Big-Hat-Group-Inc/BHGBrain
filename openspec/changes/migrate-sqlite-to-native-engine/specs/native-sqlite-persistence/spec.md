## ADDED Requirements

### Requirement: Persisted mutations SHALL cost proportional to the change, not the store
The metadata store SHALL persist mutations through page-level journaling (WAL) so
that the I/O and event-loop cost of a write is a function of the change size, and
startup SHALL NOT require reading the entire database image into memory.

#### Scenario: Write cost at scale
- **WHEN** a single memory is inserted, updated, or deleted in a store containing
  many memories
- **THEN** the persistence work SHALL be proportional to that mutation
- **AND** SHALL NOT re-serialize or rewrite the full database file

#### Scenario: Startup on a large store
- **WHEN** the server starts against an existing large `brain.db`
- **THEN** the store SHALL open the file directly without a whole-file read

### Requirement: Committed writes SHALL be durable without a deferred-flush window
A write acknowledged to the caller SHALL survive an application crash, with no
scheduled-flush interval during which acknowledged data can be lost.

#### Scenario: Crash after acknowledged write
- **WHEN** a memory write completes and the process then crashes before any
  explicit flush
- **AND** the store is reopened
- **THEN** the written memory SHALL be present

#### Scenario: Legacy flush call sites remain valid
- **WHEN** existing code calls `flush()`, `flushIfDirty()`, or
  `scheduleDeferredFlush()`
- **THEN** the calls SHALL succeed as checkpoints or no-ops with no behavioral
  requirement placed on callers

### Requirement: Backup and restore SHALL preserve the existing format and integrity checks
`exportData()` SHALL produce a standalone SQLite image compatible with the `.bhgb`
backup format, and restore SHALL activate a backup image safely while the store is
open, on all supported platforms.

#### Scenario: Backup image is self-contained
- **WHEN** a backup is created
- **THEN** the embedded database bytes SHALL open as a complete SQLite database
  with no sidecar (WAL) files required
- **AND** the header checksum and memory-count cross-checks SHALL behave as before

#### Scenario: Restore over an open store
- **WHEN** a restore activates a backup image while the store holds an open
  connection
- **THEN** the store SHALL close its connection and remove stale journal sidecar
  files before the database file is replaced
- **AND** the restored data SHALL be active afterward

### Requirement: The engine migration SHALL be transparent at the storage seam
The `SqliteStorage` interface, SQL semantics, schema migrations, and on-disk SQLite 3
format SHALL be unchanged; existing `brain.db` files SHALL open without a data
migration step.

#### Scenario: Existing database opens in place
- **WHEN** the new engine opens a `brain.db` written by the previous engine
- **THEN** all memories, categories, audit entries, and state tables SHALL be
  readable and writable without conversion

#### Scenario: Callers are unchanged
- **WHEN** the storage manager, tools, backup, bootstrap, and search layers use the
  store
- **THEN** no call-site changes SHALL be required by the engine swap

### Requirement: FTS5 capability SHALL be reported truthfully by the existing probe
The startup FTS5 probe SHALL remain the single authority on fulltext-engine
capability, and health reporting SHALL reflect its result.

#### Scenario: FTS5-enabled build
- **WHEN** the store initializes on an engine build that ships the fts5 module
- **THEN** `isFts5Available()` SHALL return `true`
- **AND** the `sqlite` health component SHALL NOT report the legacy-fulltext
  fallback message

#### Scenario: FTS5-less build remains degraded-but-visible
- **WHEN** the store initializes on an engine build without fts5
- **THEN** the probe SHALL return `false`
- **AND** fulltext search SHALL continue on the legacy matcher with the fallback
  surfaced in health
