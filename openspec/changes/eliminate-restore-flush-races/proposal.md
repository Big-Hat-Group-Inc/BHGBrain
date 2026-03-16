## Why

Backup restore and SQLite runtime reload are still vulnerable to deferred-flush timer races and in-flight mutation overlap. A restore that writes valid bytes to disk can still be followed by stale or concurrent runtime persistence behavior.

## What Changes

- Define explicit coordination rules between backup restore, SQLite reload, deferred flush timers, and active mutations.
- Require restore activation to cancel or quarantine pending deferred persistence work before replacing runtime state.
- Add restore-time locking so no new read/write paths can schedule persistence against stale runtime state.

## Capabilities

### New Capabilities
- `backup-restore-flush-coordination`: Restore activation coordinates runtime flush state and in-flight operations safely.

### Modified Capabilities
- `backup-restore-runtime-activation`: Activation behavior is strengthened with timer and concurrency guarantees.

## Impact

- Affected code: `src/backup/index.ts`, `src/storage/sqlite.ts`, `src/index.ts`, request handlers that mutate SQLite state.
- Reliability: prevents restored state from being overwritten or mixed with pre-restore runtime state.
