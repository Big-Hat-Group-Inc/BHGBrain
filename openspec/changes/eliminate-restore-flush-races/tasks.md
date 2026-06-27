## 1. Storage Lifecycle Coordination

- [x] 1.1 Add explicit APIs to cancel, drain, or quarantine deferred flush state during reload.
- [x] 1.2 Add a restore/runtime lock that prevents overlapping persistence work while reload is active.

## 2. Restore Flow Hardening

- [x] 2.1 Update backup restore to use the storage lifecycle lock.
- [x] 2.2 Return explicit failure when lifecycle coordination cannot safely activate restored state.

## 3. Verification

- [x] 3.1 Add tests for restore with a pending deferred flush timer.
- [x] 3.2 Add tests for concurrent mutation attempts during restore.

## Audit follow-ups (2026-06-05)

- [ ] 4.1 Route `markStale` (`src/storage/sqlite.ts:583-586`) and `archiveMemory` (`src/storage/sqlite.ts:773-788`) through the lifecycle guard. Both currently call `markDirty()` directly with no `assertMutableAllowed()` / lifecycle-lock check, unlike every other mutating method (`insertMemory:333`, `updateMemory:383`, `deleteMemory:435`, `setCategory:829`). These paths are driven by the retention engine (`src/backup/retention.ts:56` markStale, `src/backup/retention.ts:82` archiveMemory); a retention task resuming inside the `await reloadSqliteFromDisk()` window re-dirties the in-memory DB during restore. Either call `this.assertMutableAllowed()` at the top of both, or add an explicit `allowDuringLifecycle` opt-out mirroring `markVectorSync` (`sqlite.ts:647`) with a documenting comment — no silent hole.
- [ ] 4.2 Add a real-store integration test for the signature "pending deferred flush during restore" scenario. The existing backup-restore tests mock `SqliteStore` entirely (`src/backup/index.test.ts:24-259`: `beginLifecycleOperation`/`endLifecycleOperation`/`reloadSqliteFromDisk` are `vi.fn()`), so `cancelDeferredFlush()` inside the real `reloadFromDisk`/`beginLifecycleOperation` (`sqlite.ts:287,1097`) is never exercised and a regression removing it would pass. Add an integration test using a real `SqliteStore` against a temp dir that: insert + `scheduleDeferredFlush()`, write a restored backup with different bytes, run `restore`, then assert (a) the deferred flush timer was cancelled and no stale pre-restore bytes were written, and (b) post-restore reads return the restored dataset, not the pre-restore in-memory state.
- [ ] 4.3 Add a test for a retention `markStale`/`archiveMemory` (and a normal mutation) racing an in-flight restore: start a restore with a deferred `reloadSqliteFromDisk` await, then attempt each mutation path and assert the chosen lifecycle policy (rejected/deferred) is enforced for all of them, including the formerly-unguarded retention paths from 4.1.
