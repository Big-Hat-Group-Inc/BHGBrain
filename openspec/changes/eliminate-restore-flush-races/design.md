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

4. (Audit follow-up, 2026-06-05) The lifecycle guard covers every state-mutating path, including retention.
- `markStale` (`src/storage/sqlite.ts:583-586`) and `archiveMemory` (`src/storage/sqlite.ts:773-788`) call `markDirty()` directly without `assertMutableAllowed()`, unlike all other mutators. They are driven by the retention engine (`src/backup/retention.ts:56,82`), which can resume inside the `await reloadSqliteFromDisk()` window and re-dirty the in-memory DB mid-restore. These paths SHALL route through the same guard. If retention is ever meant to be exempt, that exemption SHALL be explicit via an `allowDuringLifecycle` option mirroring `markVectorSync` (`sqlite.ts:647`) plus a comment — never an undocumented hole.

5. (Audit follow-up, 2026-06-05) Verification must exercise the real timer-cancel path, not a mock.
- The current backup-restore tests mock `SqliteStore` (`src/backup/index.test.ts:24-259`), so `cancelDeferredFlush()` inside the real `reloadFromDisk`/`beginLifecycleOperation` (`sqlite.ts:287,1097`) is never run; serialization passes only because the mock never throws. The signature "pending deferred flush during restore" scenario SHALL be covered by a real-`SqliteStore` integration test that drives an actual pending timer through `restore` and asserts both no stale write and restored-data visibility.

## Risks / Trade-offs

- [Restore briefly blocks traffic] -> Mitigation: keep the critical section narrow and surface structured busy errors.
- [Lifecycle lock adds complexity] -> Mitigation: centralize the lock in the storage layer and cover it with tests.

## Migration Plan

- Add storage lifecycle coordination APIs.
- Wire restore through the lock.
- Add regression tests for pending deferred flush and concurrent mutation cases.
