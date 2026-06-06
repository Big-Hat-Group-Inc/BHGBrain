# Code Audit — OpenSpec proposal `harden-post-restore-reconciliation`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `harden-post-restore-reconciliation`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 8 (`src/backup/index.ts`, `src/storage/index.ts`, `src/storage/sqlite.ts`, `src/storage/qdrant.ts`, `src/domain/types.ts`, `src/health/index.ts`, `src/backup/index.test.ts`, `src/storage/index.test.ts`)

## Executive summary

The proposal is fully implemented and well-covered. The restore flow now treats SQLite activation as the success boundary, degrades (rather than fails) on post-activation vector errors, persists reconciliation progress incrementally, and cleans up the restore guard on every path via a `finally` block. All four design decisions and all six tasks are satisfied, with co-located regression tests for the named failure scenarios. No Critical or High findings. The remaining observations are Medium/Low: a flush-granularity nuance that leaves a narrow non-durable window inside a successful batch, a double-counted lock guard, and minor logging/consistency polish. Overall health: strong.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Req: Restore serialization SHALL fail safe | Done | `src/backup/index.ts:81-84,138-146` — `restoreGuardAcquired` flag + `finally` releases lifecycle op and `restoreInProgress`; `beginRestoreOperation` throws before setting flag if lock busy (`:149-161`) |
| Scenario: Restore setup fails before activation completes | Done | Guard only released when acquired; test `src/backup/index.test.ts:180-223` proves a later restore starts normally after setup failure |
| Req: Activation success SHALL not be masked by later degraded work | Done | After `reloadSqliteFromDisk` succeeds, vector work is delegated to `restoreVectorStateAfterActivation` which returns a status, never throws to the outer failure path (`src/backup/index.ts:119-134,163-225`) |
| Scenario: Post-activation work fails | Done | Result preserves `metadata_activated: true` and `vector_reconciliation` degraded details; tests `src/backup/index.test.ts:67-148` |
| Req: Post-activation vector recovery failures SHALL preserve activated state | Done | `toPendingVectorReconciliation` returns `status:'degraded', state:'pending'` for invalidation/clear/reconcile failures (`src/backup/index.ts:165-225`) |
| Scenario: Vector cleanup fails after SQLite activation | Done | Clear-fail test `src/backup/index.test.ts:109-148`; health gates full readiness via `checkVectorReconciliation` (`src/health/index.ts:113-140`) |
| Req: Reconciliation progress SHALL remain durable across partial failure | Done | `reconcileVectorsFromSqlite` calls `markVectorSync(...,true)` per successful upsert and `flushIfDirty()` before re-throwing on failure (`src/storage/index.ts:230-248`) |
| Scenario: Reconciliation fails after some restored memories are rebuilt | Done | Storage test `src/storage/index.test.ts:207-240` asserts synced subset survives, remaining stays pending, retry resumes |
| Task 1.1 Fail-safe restore lifecycle acquisition/cleanup | Done | `src/backup/index.ts:81-84,138-146` |
| Task 1.2 Activation success → degraded readiness on later failure | Done | `src/backup/index.ts:119-134,163-225` |
| Task 2.1 Persist reconciliation progress incrementally | Done | `src/storage/index.ts:238-248` (per-item mark + flush on failure boundary) |
| Task 2.2 Retries/health resume from remaining unsynced set | Done | Cursor scan over `listMemoriesNeedingVectorSync` (`src/storage/index.ts:211-255`); health reads `countUnsyncedVectors` (`src/health/index.ts:114`) |
| Task 3.1 Regression tests (clear-fail, partial durability, guard cleanup) | Done | `src/backup/index.test.ts:67-223`, `src/storage/index.test.ts:207-240` |
| Task 3.2 Run lint/test/build | Partial | No artifact in repo proves it ran; code typechecks on read but the audit did not execute the commands |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | Medium | High | S | Stability | `src/storage/index.ts:223-248` | Successful upserts inside a batch are flushed only at batch end / on error, not per-item — narrow non-durable window on hard crash |
| 2 | Low | High | S | Stability | `src/backup/index.ts:13,143,149-160` | `restoreInProgress` flag is redundant with the sqlite lifecycle lock; two guards for one invariant invite divergence |
| 3 | Low | Medium | S | Logging | `src/backup/index.ts:208-225` | `toPendingVectorReconciliation` re-counts unsynced via a fresh query and logs at `warn` without the backup path/correlation field |
| 4 | Low | Medium | S | Stability | `src/storage/index.ts:257`, `src/health/index.ts:114` | `unsynced_vectors` reported from a re-query rather than the in-loop `reconciled` delta; correct but couples result to live table state |
| 5 | Low | Low | S | Testing | `src/backup/index.test.ts` | Vector-invalidation (`markAllMemoriesVectorSync` throw) and `remaining > 0` degraded branches are not directly exercised at the backup layer |

## Quick wins

- Add a backup-layer test for the `markAllMemoriesVectorSync` throw branch and the `remaining > 0` degraded return (Finding 5) — both are live code paths with no direct coverage.
- Include `path`/correlation context in the `toPendingVectorReconciliation` warn log to match the info logs in the same flow (Finding 3).

## Performance

No issues found. Reconciliation uses a keyset cursor (`created_at|id`) over an indexed-friendly predicate and batches embeddings via `embedBatch` (`src/storage/index.ts:211-255`); `clearManagedCollections` is O(collections) with circuit-breaker protection (`src/storage/qdrant.ts:296-314`). No N+1 or unbounded loads in the restore path.

## Logging & observability

### [Low · Medium · S] Degraded-path warn log omits correlation/path context — `src/backup/index.ts:208-225`
**Issue:** The info logs in `restore` carry `path: backupPath` (`:85,105,108,121`), but `toPendingVectorReconciliation` logs only `{ event, error }` with no `path` or restore correlation field. It also issues a fresh `countUnsyncedVectors()` query purely to populate the log/result.
**Why it matters:** During a real incident, the degraded warning is the most operationally important line, yet it is the one missing the identifier that ties it to the originating restore. Structured-log consistency is a stated house convention.
**Recommendation:** Thread `backupPath` (or a restore id) into `restoreVectorStateAfterActivation`/`toPendingVectorReconciliation` and include it in the warn payload.

## Stability & reliability

### [Medium · High · S] Per-item reconciliation progress is durable only at batch/error boundaries — `src/storage/index.ts:223-248`
**Issue:** Each successful `qdrant.upsert` is followed by `markVectorSync(memory.id, true, ...)` which only sets the in-memory dirty flag (`src/storage/sqlite.ts:651-652`). The durable `flushIfDirty()` runs once per batch (`:248`) or on the error boundary (`:243`). So within a 100-item batch, items 1..k can be upserted to Qdrant and marked synced in memory, but if the process is hard-killed (OOM/SIGKILL) before the batch flush — not via a thrown error — those marks are lost and the next run re-embeds and re-upserts them.
**Why it matters:** The spec's durability guarantee is framed around "a later upsert fails in the same run," which the flush-on-throw path satisfies. But the design rationale ("avoids repeating already completed rebuild work after restart") is only partially met for the crash case. Re-upsert is idempotent, so this is correctness-safe but does redundant embedding work (cost + latency) on restart.
**Recommendation:** Either document this as an accepted bound (flush is per-batch by design, per design.md risk note "flush per completed chunk") or reduce batch size for the restore reconciliation path so the chunk boundary is tighter. No code defect — this is a durability-granularity trade-off worth recording explicitly.

### [Low · High · S] Duplicate restore-in-progress guards — `src/backup/index.ts:13,143,149-160`
**Issue:** Restore serialization is enforced twice: the instance field `restoreInProgress` (`:13,150,160`) and the sqlite `beginLifecycleOperation('restore')` lock (`:155`, `src/storage/sqlite.ts:1093-1099`). `beginRestoreOperation` checks the field first, then the lock; the `finally` clears both.
**Why it matters:** Two sources of truth for one mutual-exclusion invariant can drift if a future edit touches one path only (e.g., an early return that resets the field but not the lock). The lifecycle lock is already authoritative and is what the health surface reads (`src/health/index.ts:115-117`).
**Recommendation:** Consider collapsing to the lifecycle lock alone (catch its throw and translate to "already in progress"), eliminating the redundant boolean. Current code is correct; this is defensive simplification.

### [Low · Medium · S] Reported `remaining`/`unsynced_vectors` derives from a live re-query — `src/storage/index.ts:257`
**Issue:** `reconcileVectorsFromSqlite` returns `remaining: this.sqlite.countUnsyncedVectors()` rather than deriving it from the `reconciled` counter and the known input set. Health does the same (`src/health/index.ts:114`).
**Why it matters:** Correct under the current single-writer-during-restore model, but it couples the returned status to whatever else may have touched `vector_synced` between the loop and the count. Within the restore lifecycle nothing else writes, so this is presently safe.
**Recommendation:** Acceptable as-is given lifecycle serialization; if non-restore reconciliation ever runs concurrently, compute remaining from the iterated set instead.

## Security

No issues found. Restore validates the backup checksum before activation (`src/backup/index.ts:96-100`), writes atomically (`atomicWriteFileSync`), and reads only an operator-supplied local path with an existence check. No secrets, injection, or deserialization-of-untrusted-code concerns in the audited paths.

## Maintainability & code quality

No issues found. The restore method is cohesive and the vector-recovery logic is cleanly decomposed into `restoreVectorStateAfterActivation` → `reconcileVectorsAfterRestore` → `toPendingVectorReconciliation`, each with a single responsibility (`src/backup/index.ts:163-225`). Types (`RestoreResult`, `VectorReconciliationStatus`) are shared with the health surface (`src/domain/types.ts:105-114`), and the `archived = 0` filter is applied consistently across `countMemories`/`markAllVectorsSyncState`/`countUnsyncedVectors`.

## Testing & coverage

### [Low · Low · S] Two degraded branches lack direct backup-layer coverage — `src/backup/index.test.ts`
**Issue:** Tests cover activation success, reconcile-throw (embeddings unavailable), clear-throw, activation failure, and guard cleanup. Not directly exercised at the backup layer: (a) `markAllMemoriesVectorSync` throwing → `backup_restore_vector_invalidation_pending` (`src/backup/index.ts:165-167`), and (b) a successful `reconcileVectorsFromSqlite` returning `remaining > 0` → degraded result (`src/backup/index.ts:190-196`).
**Why it matters:** Both are reachable production branches; (b) in particular is the normal "large restore still draining" outcome and is only validated transitively. The partial-durability mechanics are well covered one layer down (`src/storage/index.test.ts:207-240`).
**Recommendation:** Add two small cases mirroring the existing mock-storage pattern: one where `markAllMemoriesVectorSync` throws, one where `reconcileVectorsFromSqlite` resolves `{ reconciled: n, remaining: m>0 }`.

## Dependencies & supply chain

No issues found. No new dependencies are introduced by this change; the restore path relies on `node:crypto`/`node:fs`, the existing sql.js store, and the Qdrant client already in use.

## Recommendations (prioritized)

1. **(Medium)** Decide and document the reconciliation flush granularity (Finding 1): either accept per-batch durability as the contract or shrink the restore batch size so crash-window redundant work is bounded.
2. **(Low)** Add the two missing backup-layer tests for the invalidation-throw and `remaining > 0` degraded branches (Finding 5).
3. **(Low)** Add `path`/correlation context to the degraded warn log for incident traceability (Finding 3).
4. **(Low)** Collapse the redundant `restoreInProgress` boolean into the authoritative lifecycle lock (Finding 2).
5. **(Housekeeping)** Capture evidence that Task 3.2 (`npm run lint && npm test && npm run build`) passed, since it is the only Partial item in the compliance table.
