# Code Audit — OpenSpec proposal `eliminate-restore-flush-races`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `eliminate-restore-flush-races`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 9 (`src/backup/index.ts`, `src/backup/index.test.ts`, `src/backup/retention.ts`, `src/storage/index.ts`, `src/storage/sqlite.ts`, `src/storage/sqlite.test.ts`, `src/storage/index.test.ts`, `src/resources/index.ts`, `src/search/index.ts`)

## Executive summary

The proposal is substantially implemented: a storage-level lifecycle lock (`lifecycleOperation`) plus an explicit `cancelDeferredFlush()` at reload time closes the two headline race windows (a pending deferred-flush timer writing stale bytes after activation, and concurrent mutations interleaving with activation). Restore is serialized, returns explicit failures on activation error, and clears the deferred timer before swapping the in-memory DB. The core design is sound for the single-threaded Node event-loop model these stores run in.

The gaps are at the edges. Two mutation methods (`markStale`, `archiveMemory`) bypass the lifecycle guard entirely, leaving a narrow window where retention work scheduled during a restore can re-dirty the new DB. Read-path access tracking silently no-ops under the lock (rows are simply not updated) rather than being deferred, which is an acceptable but undocumented policy choice. The verification tests are the weakest area: every backup-restore test mocks `SqliteStore` with `vi.fn()`, so the actual lock-and-cancel interaction with a *real* deferred-flush timer — the precise hazard the proposal targets — is never exercised end to end. No Critical findings. Highest severity is Medium.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Req: Restore activation must coordinate deferred persistence state (cancel/neutralize deferred flush before activation completes) | Done | `src/storage/sqlite.ts:1097` (`beginLifecycleOperation` → `cancelDeferredFlush`), `src/storage/sqlite.ts:287` (`reloadFromDisk` → `cancelDeferredFlush` + `dirty=false`), `src/storage/sqlite.ts:317` (scheduling is suppressed while `lifecycleOperation` set) |
| Scenario: Pending deferred flush exists during restore → no stale write; reads observe restored dataset | Done (logic) / Partial (test) | Logic at `sqlite.ts:287-299`; no integration test drives a real pending timer through restore — see Testing finding T-1 |
| Req: Restore must serialize runtime persistence activity (no concurrent persistence overlapping activation) | Done | `src/backup/index.ts:149-161` (`restoreInProgress` + `beginLifecycleOperation`), `src/storage/sqlite.ts:1093-1099` (lock throws on re-entry), `assertMutableAllowed` guards mutating writes `sqlite.ts:1329-1333` |
| Scenario: Mutation arrives during restore → rejected or deferred by explicit policy; restored state stays consistent | Partial | Most mutations throw via `assertMutableAllowed` (`sqlite.ts:333,383,435,472,829,…`); access-tracking writes silently no-op (`sqlite.ts:610,627,671`); but `markStale`/`archiveMemory` are unguarded — see Stability finding S-1 |
| Task 1.1 Add APIs to cancel/drain/quarantine deferred flush during reload | Done | `cancelDeferredFlush` `sqlite.ts:325-330`; called from `reloadFromDisk` `sqlite.ts:287` and `beginLifecycleOperation` `sqlite.ts:1097` |
| Task 1.2 Add restore/runtime lock preventing overlapping persistence work | Done (with gap) | `beginLifecycleOperation`/`endLifecycleOperation`/`assertMutableAllowed` `sqlite.ts:1093-1106,1329-1333`; gap: `markStale`/`archiveMemory` not covered — S-1 |
| Task 2.1 Update backup restore to use the storage lifecycle lock | Done | `src/backup/index.ts:83,141,149-161` |
| Task 2.2 Return explicit failure when coordination cannot safely activate | Done | `src/backup/index.ts:110-117` (activation failure → `internal(...)`), `:150-158` (busy → `invalidInput('...already in progress')`) |
| Task 3.1 Tests for restore with a pending deferred flush timer | Partial/Drifted | No test schedules a real deferred-flush timer and asserts it is cancelled by restore. `sqlite.test.ts:227-239` tests batching but not the restore interaction; backup tests mock sqlite — T-1 |
| Task 3.2 Tests for concurrent mutation attempts during restore | Partial | `sqlite.test.ts:241-254` asserts a mutating write throws and access updates skip under the lock (good unit coverage); backup `:225-259` serializes *restores* but no test mixes a real mutation with an in-flight restore — T-2 |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| S-1 | Medium | High | S | Stability | `src/storage/sqlite.ts:583-586,773-788` | `markStale`/`archiveMemory` bypass the lifecycle guard, allowing writes during restore |
| S-2 | Low | High | S | Stability | `src/storage/sqlite.ts:610,627,671` | Access-tracking silently no-ops under the lock; policy is implicit and lossy |
| S-3 | Low | Medium | S | Stability | `src/backup/index.ts:149-161` | Restore serialization leans on a JS boolean in addition to the lock; redundant guards can drift |
| T-1 | Medium | High | M | Testing | `src/backup/index.test.ts:24-259` | All restore tests mock `SqliteStore`; the real timer-cancel-on-reload path is untested |
| T-2 | Low | Medium | S | Testing | `src/storage/sqlite.test.ts:241-254` | No end-to-end test of a mutation racing an in-flight restore activation |
| L-1 | Low | High | S | Logging | `src/storage/sqlite.ts:610,627,671` | Skipped access updates during lifecycle ops are silent (no debug log/metric) |
| M-1 | Low | Medium | S | Maintainability | `src/backup/index.ts:13,149-161` | Two overlapping locks (`restoreInProgress` + `lifecycleOperation`) for one invariant |

## Quick wins

- S-1: add `this.assertMutableAllowed()` to `markStale` and `archiveMemory` (or document why they are intentionally exempt). One line each.
- L-1: emit a `logger.debug`/counter when access updates are skipped because `lifecycleOperation` is set, so the lossy behavior is observable.
- M-1: drop the redundant `restoreInProgress` boolean and rely solely on the storage lock, or add a comment explaining why both exist.

## Performance

No issues found. The lifecycle lock and `cancelDeferredFlush` are O(1); restore’s critical section is bounded by a single `db.export()`/`readFileSync` and is appropriately narrow.

## Logging & observability

### [Low · High · S] Skipped access updates under lifecycle lock are silent — `src/storage/sqlite.ts:610`

**Issue:** `touchMemory` (`:610`), `recordAccess` (`:627`), and `recordAccessBatch` (`:671`) early-return when `lifecycleOperation` is set, silently dropping access-count/last-accessed updates. Callers (`src/resources/index.ts:65-66`, `src/search/index.ts:239-240`) then call `scheduleDeferredFlush()` which is also a no-op under the lock. Nothing records that updates were discarded.

**Why it matters:** During a restore, read traffic loses access metrics with no trace. Operators cannot tell whether access counters are accurate after a restore, and there is no metric to size how often this happens.

**Recommendation:** Emit a `logger.debug({ event: 'access_update_skipped_lifecycle', op })` or increment a counter at the early-return sites. Keep it cheap (debug level) to avoid noise.

## Stability & reliability

### [Medium · High · S] `markStale`/`archiveMemory` bypass the lifecycle guard — `src/storage/sqlite.ts:583`

**Issue:** Every other mutating method calls `assertMutableAllowed()` before writing (e.g. `insertMemory` `:333`, `updateMemory` `:383`, `deleteMemory` `:435`, `setCategory` `:829`). `markStale` (`:583-586`) and `archiveMemory` (`:773-788`) call `markDirty()` directly with no guard. The retention engine drives both (`src/backup/retention.ts:56,82`). If retention/consolidation runs while a restore holds the lifecycle lock, these writes land on the in-memory DB and set `dirty = true`.

**Why it matters:** This violates the proposal’s second requirement ("prevent concurrent persistence work from overlapping with runtime restore activation"). Concretely: in the await window of `await reloadSqliteFromDisk()` (`src/backup/index.ts:109`) the lock is held but the event loop is free; a retention task that began earlier could, on resumption, mutate state. After reload swaps in restored bytes, a subsequent `flushIfDirty()` would persist a `dirty` flag set by an unguarded write against now-stale assumptions. The window is narrow and requires retention to run concurrently with restore, but the guard is exactly the mechanism meant to close it.

**Recommendation:** Add `this.assertMutableAllowed()` at the top of `markStale` and `archiveMemory`. If retention is meant to be exempt (it runs system-side), make that explicit with an `allowDuringLifecycle` option mirroring `markVectorSync` (`:647`) and a comment, rather than leaving an undocumented hole.

### [Low · High · S] Access-tracking no-op is a silent, lossy policy — `src/storage/sqlite.ts:610`

**Issue:** The proposal says mutations during restore must be "rejected or deferred by explicit lifecycle policy." Mutating writes are *rejected* (throw); access updates are instead *dropped* (early return, `:610,627,671`). This is a defensible third policy (best-effort access stats), but it is neither rejection nor deferral, and it is not documented anywhere as the intended contract.

**Why it matters:** A reader of the spec would expect either an error or a queued-then-applied update. Silent loss is reasonable for access counters but should be a stated decision so future maintainers don’t "fix" it into a throw and break read paths during restore.

**Recommendation:** Document the policy (best-effort, may be dropped during lifecycle ops) in a comment at the early-return sites and/or in `design.md` Decision 1. Optionally pair with L-1’s debug log.

### [Low · Medium · S] Restore serialization depends on two coupled guards — `src/backup/index.ts:149`

**Issue:** `beginRestoreOperation` (`:149-161`) sets `restoreInProgress = true` *and* calls `storage.sqlite.beginLifecycleOperation('restore')`. The storage lock alone already throws on re-entry (`sqlite.ts:1094`). The boolean is a second source of truth for the same invariant; the `catch {}` at `:156` even reclassifies a real lock error into the generic "already in progress" message.

**Why it matters:** Two guards for one invariant can drift. If a future refactor releases one without the other (the `finally` at `:138-145` does both, which is correct today), serialization could silently weaken. The `catch {}` also swallows the underlying error detail.

**Recommendation:** Rely on the storage lock as the single source of truth (see M-1), or keep the boolean but assert both are released together in one place and avoid swallowing the lock’s error text.

## Security

No issues found. Restore validates a SHA-256 checksum before activation (`src/backup/index.ts:96-100`), writes atomically (`atomicWriteFileSync`), and the lock is process-local with no external input controlling it. Path comes from operator-supplied backup path, consistent with existing tool surface.

## Maintainability & code quality

### [Low · Medium · S] Duplicated locking concern across modules — `src/backup/index.ts:13`

**Issue:** The restore-in-progress invariant is represented twice: `BackupService.restoreInProgress` (`:13`) and `SqliteStore.lifecycleOperation` (`sqlite.ts:263`). The design (`design.md` Decision 1, Risk mitigation: "centralize the lock in the storage layer") explicitly calls for centralization, so the extra boolean is mild drift from the stated design.

**Why it matters:** Centralizing the lock was a named design goal; the duplicate undercuts it and adds a maintenance point.

**Recommendation:** Remove `restoreInProgress` and derive busy-state from `storage.sqlite.getLifecycleOperation()`/`isLifecycleOperationInProgress()` (already exposed, `sqlite.ts:1108-1113`), or comment the boolean as a deliberate caller-side fast-path.

## Testing & coverage

### [Medium · High · M] Restore tests mock `SqliteStore`, so the real flush/reload race is untested — `src/backup/index.test.ts:24`

**Issue:** All six restore tests build `storage` as a plain object with `vi.fn()` for `beginLifecycleOperation`, `endLifecycleOperation`, and `reloadSqliteFromDisk` (e.g. `:31-37`, `:233-245`). The proposal’s core hazard — a *real* pending `deferredFlushTimer` being cancelled by `cancelDeferredFlush()` inside the real `reloadFromDisk`/`beginLifecycleOperation` (`sqlite.ts:287,1097`) before the in-memory DB is swapped — is therefore never executed. The mocks make the lock and timer interaction unobservable.

**Why it matters:** Task 3.1 asks specifically for "restore with a pending deferred flush timer." With everything mocked, a regression that removed `cancelDeferredFlush()` from `reloadFromDisk` would not fail any restore test. The serialization test (`:225-259`) actually passes because the *mock* `beginLifecycleOperation` never throws — serialization is enforced by the JS boolean, not the lock under test.

**Recommendation:** Add an integration test using a real `SqliteStore` against a temp dir: insert+`scheduleDeferredFlush()`, write a restored backup with different bytes, run `restore`, then assert (a) `deferredFlushTimer` was cancelled (no stale write), and (b) post-restore reads return the restored dataset and not the pre-restore in-memory state.

### [Low · Medium · S] No test of a mutation racing an in-flight restore — `src/storage/sqlite.test.ts:241`

**Issue:** `sqlite.test.ts:241-254` correctly proves a mutating write throws and access updates skip *while the lock is held synchronously*. But it does not model the realistic case: a mutation/retention call arriving during the `await reloadSqliteFromDisk()` window of `BackupService.restore` (`backup/index.ts:109`). Combined with S-1, the unguarded `markStale`/`archiveMemory` path is entirely untested against the lock.

**Why it matters:** Task 3.2 ("concurrent mutation attempts during restore") is only partially demonstrated; the async-interleaving dimension and the unguarded methods are uncovered.

**Recommendation:** Add a test that starts a restore with a deferred `reloadSqliteFromDisk`, then attempts `markStale`/`archiveMemory`/a normal mutation and asserts the chosen policy (throw vs. defer) for each.

## Dependencies & supply chain

No issues found. The change introduces no new dependencies; it relies on existing `sql.js@^1.12.0`, `@qdrant/js-client-rest@^1.13.0`, and `pino@^9.6.0`, and core Node timers/crypto. Ranges and usage are consistent with the rest of the repo.

## Recommendations (prioritized)

1. **(S-1, Medium)** Guard `markStale` and `archiveMemory` with `assertMutableAllowed()` (or an explicit `allowDuringLifecycle` opt-out), closing the last unguarded mutation path through the lifecycle lock.
2. **(T-1, Medium)** Add a real-`SqliteStore` integration test that drives a pending deferred-flush timer through `restore` and asserts no stale write plus restored-data visibility — this is the proposal’s headline scenario and is currently mock-shadowed.
3. **(S-2 / L-1, Low)** Document the access-tracking "best-effort drop during lifecycle" policy and emit a debug log/metric at the early-return sites.
4. **(T-2, Low)** Add a test for a mutation arriving during an in-flight restore await.
5. **(M-1 / S-3, Low)** Centralize the restore-busy invariant on the storage lock per the design’s stated goal; remove or comment the duplicate `restoreInProgress` boolean and stop swallowing the lock’s error text.
