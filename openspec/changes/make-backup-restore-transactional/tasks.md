## 1. Durable Artifact Format

- [x] 1.1 Implement a unique-temp durable file writer with restrictive modes, file fsync, directory fsync where supported, and cleanup; verify crash/failure injection never reports a partial final artifact.
- [x] 1.2 Define and encode backup format v2 with authenticated canonical header metadata and verify body or header corruption is rejected.
- [x] 1.3 Add a compatibility parser for v1 and strict version validation; verify unsupported versions fail before any destructive action.
- [ ] 1.4 Stream backup hashing and output rather than concatenating whole buffers and verify peak-memory tests stay within a fixed bound relative to database size.

## 2. Validated Transactional Restore

- [ ] 2.1 Add scratch-image open, integrity, schema, and record-count validation and verify invalid SQLite and count mismatch leave the live store untouched.
- [ ] 2.2 Add an exclusive data-directory restore lock and verify overlapping server/CLI restore or mutation attempts receive a retryable conflict.
- [ ] 2.3 Implement checkpoint, rename-aside activation, rollback, and reopen handling and verify injected failures at every swap boundary restore the prior database.
- [ ] 2.4 Consolidate archive restore mapping and verify checksum, expiry, review, and provenance fields match across tool and CLI entrypoints.
- [ ] 2.5 Preserve actual lifecycle lock-holder and activation errors in restore results and verify logs and error codes name the real conflict.

## 3. Vector and Backup Reconciliation

- [ ] 3.1 Stream restored-ID/checksum comparison against managed vector points and verify stale, missing, and surplus sets are computed without whole-collection buffering.
- [ ] 3.2 Delete surplus managed points in bounded batches or retain explicit orphan progress on failure and verify Qdrant-only memories cannot surface as payload fallbacks after successful restore.
- [ ] 3.3 Distinguish model change, transient inspection failure, and checksum drift in restore outcome/health and verify a read outage does not trigger a mislabeled full rebuild.
- [ ] 3.4 Add backup count/age retention with coordinated metadata cleanup and verify missing files are flagged and old files are pruned after success.
- [ ] 3.5 Update README backup format, retention, permissions, and restore guarantees, then run backup/restore tests, `npm run lint`, `npm test`, and `npm run build`.
