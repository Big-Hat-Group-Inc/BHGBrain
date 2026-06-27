## Why

The restore path was hardened to keep SQLite activation as the success boundary and to degrade (rather than fail) on post-activation vector errors. Two audits of the completed `restore-dual-store-backup-consistency` and `harden-post-restore-reconciliation` changes confirmed correctness but surfaced net-new operational concerns that those changes explicitly deferred:

- Every restore unconditionally marks the entire dataset unsynced, drops all managed Qdrant collections, and re-embeds the whole corpus regardless of how much actually drifted (`src/backup/index.ts:163-177`). For a large brain or a slow embedding provider this turns restore into an O(N) re-embed with real cost, multi-minute latency, and a wide empty-vector window — the exact "very large restore" case the prior design flagged in its Open Question but left unresolved.
- Reconciliation runs synchronously, unbounded (no timeout or cap), while holding the restore lifecycle lock (`src/storage/index.ts:204-258`). A slow, rate-limited, or hanging embedding provider blocks the restore call and the lifecycle lock indefinitely, and gates the health `reconciling` transition behind full completion.
- Managed Qdrant collections are dropped before any rebuild (`src/backup/index.ts:171`), so a failed reconciliation leaves semantic search fully blank with no automatic retry — recovery depends on an external trigger.
- Successful in-batch sync marks are flushed only at batch/error boundaries (`src/storage/index.ts:223-248`), so a hard crash (SIGKILL/OOM) mid-batch loses those marks and forces idempotent re-upsert of already-rebuilt rows on restart.
- The backup format is intentionally SQLite-only with vectors rebuilt on restore, but that intent is not documented in-code, inviting future re-litigation across the overlapping restore proposals.

## What Changes

- Make restore reconcile only the actual drift: skip re-embedding memories whose vectors already match in Qdrant instead of unconditionally clearing and re-embedding the whole dataset.
- Bound reconciliation with a timeout/iteration cap and stop holding the restore lifecycle lock for the full re-embed; return `reconciling`/`pending` early and let reconciliation continue (resumably) in a bounded background task.
- Preserve existing vectors until a rebuild succeeds (or provide auto-retry / a degraded signal) so a failed reconciliation does not leave search blank.
- Make reconciliation sync-mark durability bounded at batch granularity (or explicitly document and guarantee the idempotent-replay behavior on crash).
- Document that backups are intentionally SQLite-only and vectors are rebuilt from SQLite on restore.

## Capabilities

### New Capabilities
- `bounded-restore-reconciliation`: restore reconciles only actual vector drift, runs reconciliation under a bound (timeout/cap) without holding the lifecycle lock for the full re-embed, keeps semantic search usable until a rebuild succeeds, and guarantees durable, resumable reconciliation progress.

### Modified Capabilities

## Impact

- Affected code: `src/backup/index.ts`, `src/storage/index.ts`, `src/storage/qdrant.ts`, `src/storage/sqlite.ts`, `src/health/index.ts`, and restore-related tests.
- API behavior: large/slow restores return `reconciling`/`pending` promptly instead of blocking on the full re-embed; no-drift restores complete cheaply without re-embedding.
- Reliability/performance: removes the unbounded lock-held re-embed, narrows the empty-vector window, avoids redundant embedding cost, and bounds crash-window rework.
- Docs: backup format intent (SQLite-only, vectors rebuilt on restore) becomes explicit in-code.
