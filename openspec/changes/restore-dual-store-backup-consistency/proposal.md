## Why

Backup restore now reactivates SQLite correctly in-process, but the system is still a dual-store design and restore only persists SQLite bytes. That leaves restored metadata and Qdrant vector state free to drift apart, which can break semantic search, similarity dedup, and health expectations after restore.

## What Changes

- Define backup and restore as a dual-store consistency workflow instead of a SQLite-only workflow.
- Require restore to either recover vector state alongside SQLite or enter an explicit reconciliation mode that rebuilds or marks vector state before normal semantic features resume.
- Define operator-visible restore results and health signals for post-restore vector consistency.
- Add integrity and regression coverage for restore scenarios where SQLite state is older than Qdrant state.

## Capabilities

### New Capabilities
- `dual-store-backup-restore-consistency`: ensures backup and restore preserve or explicitly reconcile both SQLite metadata and Qdrant vector state.

### Modified Capabilities

## Impact

- Affected code: `src/backup/index.ts`, `src/storage/index.ts`, `src/storage/qdrant.ts`, `src/storage/sqlite.ts`, `src/health`, and related restore tests.
- API behavior: restore responses and health reporting become explicit about vector recovery state.
- Reliability: prevents false-success restores that leave semantic search and dedup operating on stale or missing vectors.
