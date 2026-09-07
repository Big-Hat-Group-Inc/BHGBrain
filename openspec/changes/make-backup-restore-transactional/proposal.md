## Why

Restore can replace the live SQLite database before validating the incoming image and cannot roll back a failed activation. Backup artifacts are also memory-heavy, weakly authenticated at the header boundary, unpruned, and unable to remove Qdrant points absent from the restored source of truth.

## What Changes

- Validate backup format, header integrity, SQLite integrity, and expected counts in a scratch database before activation.
- Preserve and reopen a pre-restore database when activation or post-activation checks fail, with cross-process exclusion around file replacement.
- Reconcile in both directions after restore, including pruning or explicitly reporting Qdrant-only points.
- Make backup/config file writes durable with unique temporary files, restrictive permissions, cleanup, and directory synchronization.
- Stream backup hashing/copying to cap memory and add retention for backup files and metadata.
- Consolidate archive restoration through one correct checksum/lifecycle mapping and accurately classify restore conflicts and drift causes.

## Capabilities

### New Capabilities
- `transactional-backup-restore`: Defines validated, rollback-capable activation, durable backup artifacts, bounded creation, bidirectional vector reconciliation, and backup retention.

### Modified Capabilities

## Impact

- Affected code: `src/backup/index.ts`, `src/backup/retention.ts`, `src/storage/sqlite.ts`, `src/storage/index.ts`, `src/storage/qdrant.ts`, configuration, health, CLI restore handling, and backup tests.
- Audit coverage: F10, F12, F24, F29, F30, F44, F58, F62, F64, and F85-F88.
- Recovery behavior: a reported restore failure leaves the prior store recoverable and reports vector readiness separately.
