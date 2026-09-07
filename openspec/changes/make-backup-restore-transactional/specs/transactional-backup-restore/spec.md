## Purpose

Defines backup creation and restore as durable, bounded, validated recovery operations that preserve the prior database until replacement and vector reconciliation are known to be safe.

## ADDED Requirements

### Requirement: Backup artifacts SHALL be validated before activation
Restore SHALL validate the supported format version, authenticated header fields, body checksum, SQLite integrity, schema readability, and declared record counts before replacing the active database.

#### Scenario: Self-consistent file is not a valid database
- **WHEN** a backup has a valid body checksum but its body is not an openable compatible SQLite image
- **THEN** restore fails before changing the active database

#### Scenario: Unsupported backup version is supplied
- **WHEN** the header version is not supported by the running binary
- **THEN** restore returns an invalid-input error before using any header field destructively

### Requirement: Activation SHALL be rollback-capable
Restore SHALL preserve a recoverable pre-restore database and SHALL reopen it if replacement, activation, or post-activation validation fails.

#### Scenario: Activation fails after the live connection closes
- **WHEN** the candidate image cannot become the active database
- **THEN** the prior image is restored and reopened
- **AND** the response states that activation failed without implying the old store was lost

### Requirement: Restore SHALL exclude other database processes
The destructive activation interval SHALL acquire an inter-process exclusion mechanism and return a retryable conflict when another process is using the same data directory incompatibly.

#### Scenario: CLI and server overlap a restore
- **WHEN** one process holds the restore exclusion and another process attempts a conflicting database operation
- **THEN** the second operation fails visibly without writing to an unlinked or replaced database image

### Requirement: Post-restore vector state SHALL reconcile in both directions
The restored SQLite image SHALL be the source of truth: missing or stale vectors SHALL be rebuilt, and vector-only points SHALL be removed or reported as explicit retryable orphan work before semantic readiness is healthy.

#### Scenario: Restored backup predates vector points
- **WHEN** the vector store contains points absent from the restored SQLite image
- **THEN** those points are pruned or counted as unresolved orphans
- **AND** they cannot appear in recall as non-expiring payload fallbacks

### Requirement: Backup files SHALL be durably and securely committed
Backup, configuration, and restored database files SHALL use unique temporary files, restrictive permissions, file and directory synchronization where supported, and temporary-file cleanup on failure.

#### Scenario: Process or host stops after backup success
- **WHEN** backup creation reports success before an abrupt restart
- **THEN** the final backup path contains the complete committed artifact or the operation had not reported success

### Requirement: Backup creation and retention SHALL be bounded
Creating a backup SHALL stream body hashing and copying with bounded memory, and configured retention SHALL prune stale files and matching metadata while reporting missing artifacts.

#### Scenario: Large database is backed up
- **WHEN** the database size exceeds the normal JavaScript heap comfort range
- **THEN** backup creation does not allocate multiple whole-database buffers

#### Scenario: Retention removes an old backup
- **WHEN** a backup exceeds the configured count or age policy
- **THEN** its file and metadata record are removed consistently

### Requirement: Archive restoration SHALL preserve field semantics
Every archive restore entrypoint SHALL use one mapping for content checksum, expiry, review, and provenance fields.

#### Scenario: Archived memory is restored through the CLI path
- **WHEN** an archived record is restored
- **THEN** its checksum is derived from restored content semantics rather than an unrelated identifier
