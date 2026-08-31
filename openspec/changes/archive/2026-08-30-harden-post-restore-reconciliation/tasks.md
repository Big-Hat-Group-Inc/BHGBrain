## 1. Restore control flow hardening

- [x] 1.1 Refactor `BackupService.restore` so restore lifecycle acquisition and in-progress cleanup are fail-safe across lock-acquisition and early-failure paths.
- [x] 1.2 Update restore semantics so once SQLite activation succeeds, later vector clear or reconciliation failures return explicit degraded readiness instead of full restore failure.

## 2. Reconciliation durability

- [x] 2.1 Persist successful post-restore reconciliation progress incrementally so completed vector rebuild work survives a later failure in the same run.
- [x] 2.2 Ensure reconciliation retries and health/reporting surfaces continue from the remaining unsynced set after partial failure.

## 3. Validation

- [x] 3.1 Add regression tests for post-activation vector-clear failure handling, partial reconciliation durability, and restore guard cleanup.
- [x] 3.2 Run `npm run lint`, `npm test`, and `npm run build` to verify the hardened restore behavior end to end.
