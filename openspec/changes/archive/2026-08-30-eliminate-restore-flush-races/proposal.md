## Why

Backup restore and SQLite runtime reload are still vulnerable to deferred-flush timer races and in-flight mutation overlap. A restore that writes valid bytes to disk can still be followed by stale or concurrent runtime persistence behavior.

## What Changes

- Define explicit coordination rules between backup restore, SQLite reload, deferred flush timers, and active mutations.
- Require restore activation to cancel or quarantine pending deferred persistence work before replacing runtime state.
- Add restore-time locking so no new read/write paths can schedule persistence against stale runtime state.
- Audit follow-up (2026-06-05): extend the lifecycle guard to the retention-driven mutation paths (`markStale`, `archiveMemory`) that currently bypass it, so every state-mutating operation — not just client mutations — is serialized under restore.
- Audit follow-up (2026-06-05): replace the mock-shadowed restore tests (which stub `SqliteStore` and never exercise the real `cancelDeferredFlush()` timer-cancel-on-reload path) with a real-store integration test that verifies a pending deferred flush is actually cancelled and post-restore reads return the restored dataset.

## Capabilities

### New Capabilities
- `backup-restore-flush-coordination`: Restore activation coordinates runtime flush state and in-flight operations safely.

### Modified Capabilities
- `backup-restore-runtime-activation`: Activation behavior is strengthened with timer and concurrency guarantees.

## Impact

- Affected code: `src/backup/index.ts`, `src/storage/sqlite.ts`, `src/index.ts`, request handlers that mutate SQLite state.
- Reliability: prevents restored state from being overwritten or mixed with pre-restore runtime state.
