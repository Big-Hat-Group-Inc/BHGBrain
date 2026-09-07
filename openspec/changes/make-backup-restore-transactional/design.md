## Context

Backups contain a header followed by a SQLite image, while restore currently swaps bytes into the live database before proving that image can open. Qdrant is reconstructed after activation, backup creation buffers whole files, and no cross-process lock protects sidecar or database replacement. See `proposal.md` and `specs/transactional-backup-restore/spec.md`.

## Goals / Non-Goals

**Goals:**
- Validate and authenticate the complete artifact before activation.
- Guarantee rollback to the pre-restore image after any activation failure.
- Bound backup memory and reconcile vector surplus as well as deficits.

**Non-Goals:**
- Bundling vendor-specific Qdrant snapshots.
- Providing zero-downtime restore.
- Changing SQLite as the restore source of truth.

## Decisions

1. Introduce a new backup format version with canonical authenticated metadata.
- The body checksum and a header checksum over canonical fields will be verified before those fields guide restore behavior; version 1 remains readable through a compatibility parser that never trusts unauthenticated fields destructively.
- Silently accepting every version was rejected because future body formats cannot be distinguished safely.

2. Validate in a scratch SQLite path before acquiring the short activation lock.
- Validation opens the scratch image, runs integrity/schema/count checks, and closes it before the live swap.
- Testing the image only after rename was rejected because failure destroys the recovery source.

3. Use an exclusive data-directory restore lock plus rename-aside rollback.
- The live image is checkpointed and renamed to a unique pre-restore path; the candidate is renamed into place; any failure reverses the swap and reopens the old database.
- Unlinking WAL/SHM behind another process was rejected. Cross-process callers will receive a conflict instead.

4. Reconcile vectors as a set difference against restored IDs/checksums.
- Streamed collection scans will identify stale, missing, and surplus points. Surplus managed points are deleted in bounded batches; failure keeps readiness degraded with counts/cursors.
- Clearing every vector on any scan error was rejected because a transient read failure should not trigger a full rebuild.

5. Stream backup output through hashing into a unique temporary artifact.
- File content is fsynced before rename, then the directory is synchronized where supported; file modes are explicitly restrictive.
- Whole-image `Buffer.concat` was rejected due to event-loop and heap amplification.

6. Prune backups by count and age after a successful create or cleanup pass.
- Metadata and file deletion are coordinated, and list results flag missing artifacts instead of presenting them as valid.
- Unlimited retention was rejected because backup growth is proportional to database size.

## Risks / Trade-offs

- [Format version change complicates compatibility] -> Keep a read-only v1 parser and emit v2 for new artifacts.
- [Directory fsync varies by platform] -> Require it where supported and handle documented unsupported errors explicitly.
- [Orphan pruning can be destructive if ownership filters are wrong] -> Restrict deletion to managed collection prefixes and payload identity, with dry-run counts before commit.

## Migration Plan

1. Add durable file writer, v2 encoder/parser, and scratch-image validator.
2. Add cross-process restore lock and rollback activation with failure-injection tests.
3. Add bidirectional streamed vector reconciliation and readiness fields.
4. Add backup retention configuration and metadata/file reconciliation.
5. Preserve pre-restore images until the new database and vector reconciliation state are recorded; prune them only after success.
