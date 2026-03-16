## Context

`SqliteStore` uses an in-memory `sql.js` database plus deferred flush timers. `BackupService.restore` writes restored bytes and reloads storage, but the runtime contract does not yet state how pending flushes and concurrent requests are handled during activation.

## Goals / Non-Goals

**Goals:**
- Ensure restore activation is serialized.
- Prevent pending deferred flushes from writing stale state after reload.
- Reject or pause new mutations while restore is in progress.

**Non-Goals:**
- Changing backup file format.
- Multi-process restore orchestration.

## Decisions

1. Restore acquires an exclusive storage lifecycle lock.
- While held, mutation and read paths that persist access metadata cannot schedule new flush work.

2. Reload explicitly drains lifecycle state.
- Before replacing the in-memory DB, the store cancels deferred timers and resolves pending persistence state according to restore policy.

3. Activation is all-or-nothing from the caller perspective.
- If reload coordination fails, restore returns an error and operators receive explicit guidance.

## Risks / Trade-offs

- [Restore briefly blocks traffic] -> Mitigation: keep the critical section narrow and surface structured busy errors.
- [Lifecycle lock adds complexity] -> Mitigation: centralize the lock in the storage layer and cover it with tests.

## Migration Plan

- Add storage lifecycle coordination APIs.
- Wire restore through the lock.
- Add regression tests for pending deferred flush and concurrent mutation cases.
