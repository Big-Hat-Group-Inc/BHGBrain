# Code Audit — OpenSpec proposal `restore-dual-store-backup-consistency`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `restore-dual-store-backup-consistency`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 14

## Executive summary

The proposal is **substantively implemented and well-tested**. Restore no longer ends after activating SQLite bytes: it invalidates vector sync markers, clears the managed Qdrant collections, and re-upserts vectors from restored SQLite rows, returning a structured `RestoreResult` that separates `metadata_activated` from a `vector_reconciliation` status. Health reporting (`src/health/index.ts:113`) surfaces a matching `reconciled` / `reconciling` / `pending` state. Degraded paths (embeddings unavailable, Qdrant clear failure) are preserved and explicitly reported. All four spec scenarios and all six `tasks.md` items have evidence.

The findings are about **operational robustness, not correctness gaps**. The dominant data-integrity concern is that every restore unconditionally marks the *entire* dataset unsynced, drops all managed Qdrant collections, and re-embeds every memory inline within the restore call. For a large brain this re-embeds the whole corpus on each restore (cost + latency) and widens the window during which Qdrant is empty — which the proposal explicitly anticipated ("instant semantic readiness for very large restores" is a Non-Goal), but the implementation chose the fully-synchronous, full-rebuild variant rather than the batched/background option raised in the design's Open Question. There is also no upper bound or timeout on the reconciliation loop, and reconciliation runs while holding the restore lifecycle lock, so a slow embedding provider blocks the restore call indefinitely.

No blocker or high-severity correctness defect was found. Recommended work is medium/low severity hardening.

## Spec compliance

| Requirement / Task | Status | Evidence |
| --- | --- | --- |
| Req: Restore SHALL make vector consistency explicit | Done | `RestoreResult.vector_reconciliation` (`src/domain/types.ts:110`) populated by `restore()` (`src/backup/index.ts:120-134`) |
| Scenario: Restore response distinguishes activation from reconciliation | Done | `metadata_activated: true` returned separately from `vector_reconciliation` (`src/backup/index.ts:130-134`); test `src/backup/index.test.ts:47-56` |
| Req: Restored metadata SHALL not silently trust pre-existing vector state | Done | `restoreVectorStateAfterActivation` marks all unsynced and clears managed vectors before any reconciliation (`src/backup/index.ts:163-177`) |
| Scenario: Older SQLite restore invalidates newer vector assumptions | Done | `markAllMemoriesVectorSync(false)` + `clearManagedVectors()` guarantee no reliance on pre-existing vectors; health returns `pending`/`reconciling` (`src/health/index.ts:113-140`) |
| Req: Reconciliation SHALL rebuild vectors from restored SQLite content | Done | `reconcileVectorsFromSqlite` reads SQLite rows, embeds, upserts to Qdrant, updates sync state (`src/storage/index.ts:204-258`) |
| Scenario: Reconciliation rebuilds vectors after restore | Done | Batched loop upserts into per-namespace/collection Qdrant collections and calls `markVectorSync(id,true)` (`src/storage/index.ts:217-246`); test `src/backup/index.test.ts:24-65` |
| Scenario: Restore remains degraded when embeddings unavailable | Done | `embedBatch` throws `embeddingUnavailable`; caught and mapped to `degraded`/`pending` while SQLite stays active (`src/backup/index.ts:203-225`); test `src/backup/index.test.ts:67-107` |
| Task 1.1 Extend restore & health contracts (metadata vs vector state) | Done | `RestoreResult` / `VectorReconciliationStatus` (`src/domain/types.ts:105-113`); health snapshot field (`src/domain/types.ts:122`) |
| Task 1.2 Storage/reconciliation helpers (mark unsynced, iterate rows) | Done | `markAllVectorsSyncState` (`src/storage/sqlite.ts:655`), `listMemoriesNeedingVectorSync` (`src/storage/sqlite.ts:753`), `countUnsyncedVectors` (`src/storage/sqlite.ts:745`) |
| Task 2.1 Activation does not silently trust pre-existing vectors | Done | `src/backup/index.ts:163-177` |
| Task 2.2 Post-restore re-upsert + degraded behavior when embeddings unavailable | Done | `reconcileVectorsAfterRestore` (`src/backup/index.ts:179-206`) |
| Task 3.1 Regression tests (stale vectors / success / pending-degraded) | Done | `src/backup/index.test.ts:24-148`; `src/health/index.test.ts:230-261` |
| Task 3.2 Run lint/test/build | Not verifiable from source | No CI artifact in repo; cannot confirm the commands were run |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Medium | High | M | Performance | `src/backup/index.ts:163-177` | Every restore re-embeds the entire corpus (full clear + full rebuild) regardless of how much actually drifted |
| 2 | Medium | High | M | Stability | `src/storage/index.ts:204-258` | Inline reconciliation has no timeout/bound and holds the restore lifecycle lock; slow embeddings block restore indefinitely |
| 3 | Low | High | S | Stability | `src/backup/index.ts:171` / `src/storage/qdrant.ts:296` | Qdrant collections are dropped before vectors are rebuilt, creating an empty-vector window even when reconciliation later fails |
| 4 | Low | Medium | S | Logging | `src/backup/index.ts:189-202` | Successful inline reconciliation logs no batch progress/duration; only start and final completion are recorded |
| 5 | Low | Medium | S | Maintainability | `src/backup/index.ts:23-64` | Backup `create()` still snapshots SQLite only and the version-1 header carries no vector/manifest metadata, leaving the "snapshot both stores" half of the dual-store story undocumented in-code |
| 6 | Low | Medium | S | Testing | `src/storage/index.ts:204-258` | `reconcileVectorsFromSqlite` cursor/multi-batch pagination is not directly unit-tested (backup tests mock it out) |

## Quick wins

- Add a duration/`reconciled`/`remaining` summary log to the success path (Finding 4).
- Document in the version-1 backup header (or a comment) that backups are intentionally SQLite-only and vectors are rebuilt on restore, so the format intent is explicit (Finding 5).
- Add a focused unit test for the `reconcileVectorsFromSqlite` cursor across more than one batch (Finding 6).

## Performance

### [Medium · High · M] Restore unconditionally re-embeds the entire corpus — `src/backup/index.ts:163-177`

**Issue:** `restoreVectorStateAfterActivation` always calls `markAllMemoriesVectorSync(false)` (marks every non-archived row unsynced) and `clearManagedVectors()` (deletes every managed Qdrant collection), then `reconcileVectorsFromSqlite` re-embeds and re-upserts *all* memories. There is no comparison against existing Qdrant state, no "only restore the delta" path, and no size threshold. Each restore therefore pays the full embedding cost (API calls + latency) for the entire dataset even when Qdrant was already correct.

**Why it matters:** Embedding is the dominant cost in this system. For a large brain this turns restore into an O(N) re-embed operation with real monetary cost and multi-minute latency, exactly the "very large restore" case the design called out. The design's Open Question explicitly proposed an inline-for-small / batched-background-for-large split; the implementation took the simplest full-rebuild branch and left the threshold unresolved.

**Recommendation:** Resolve the design Open Question: either (a) keep full rebuild but make it explicitly background/batched past a configurable memory-count threshold and return `reconciling` immediately for large restores, or (b) reconcile only rows whose payload/content hash differs from the existing Qdrant point. At minimum, gate the full clear behind a check so a no-drift restore is cheap.

## Logging & observability

### [Low · Medium · S] No per-batch progress or duration logging during reconciliation — `src/backup/index.ts:189-202`

**Issue:** The success path logs `backup_restore_activate_start` and `backup_restore_complete` but emits nothing between them. `reconcileVectorsFromSqlite` (`src/storage/index.ts:204-258`) loops over batches with no Pino logger and reports no per-batch counts or elapsed time. Only the failure paths log (`toPendingVectorReconciliation`).

**Why it matters:** Given Finding 1's potential multi-minute full re-embed, an operator watching logs sees a long silent gap with no way to tell whether reconciliation is progressing or stuck. This undercuts the proposal's goal of making post-restore reconciliation operator-visible.

**Recommendation:** Pass the Pino logger into the reconciliation loop (or log from `reconcileVectorsAfterRestore`) and emit per-batch `event: backup_restore_reconcile_progress` with `reconciled`/`remaining`, plus a total-duration field on completion.

## Stability & reliability

### [Medium · High · M] Inline reconciliation is unbounded and blocks the restore call/lock — `src/storage/index.ts:204-258`

**Issue:** Reconciliation runs synchronously inside `restore()` while the SQLite restore lifecycle lock is held (`beginLifecycleOperation('restore')` … `endLifecycleOperation('restore')` in `src/backup/index.ts:155,141`). The `while(true)` loop has no overall timeout, no max-iteration guard, and awaits `embedding.embedBatch` per batch. A slow, rate-limited, or hanging embedding provider keeps the restore call — and the lifecycle lock that blocks other lifecycle operations and gates health's `reconciling` state — held open for the full duration.

**Why it matters:** A restore that should be a fast metadata activation can become an open-ended operation bound to an external dependency's latency. Combined with Finding 1 (full corpus) this is the realistic failure mode for large/slow-provider restores. The proposal's own mitigation list ("allow batched reconciliation and explicit degraded health while batches run") implies reconciliation should be able to *yield* readiness early rather than block to completion.

**Recommendation:** Decouple long reconciliation from the synchronous restore response: after invalidation+clear, return `reconciling`/`pending` and run reconciliation in a bounded background task (with a per-batch timeout and a cap), letting health transition to `reconciled` when complete. If kept inline, add an overall deadline that converts to `pending` instead of blocking indefinitely.

### [Low · High · S] Managed Qdrant collections are dropped before vectors are rebuilt — `src/backup/index.ts:171`

**Issue:** `restoreVectorStateAfterActivation` calls `clearManagedVectors()` (which `deleteCollection`s every `bhg_`-prefixed collection, `src/storage/qdrant.ts:296-314`) *before* reconciliation upserts anything. If `reconcileVectorsFromSqlite` then fails (embeddings unavailable, Qdrant error mid-loop), Qdrant is left empty/partial while the result correctly reports `pending`. Until a later reconciliation succeeds, semantic search returns nothing rather than stale-but-usable results.

**Why it matters:** This is the intended trade-off (never trust pre-existing vectors), and health correctly flags `degraded`, so it is not a correctness violation. But the empty-vector window is wider than necessary and there is no automatic retry — recovery depends on an external trigger re-running reconciliation. Worth flagging for data-availability awareness.

**Recommendation:** Consider rebuilding into fresh collections and swapping, or deferring the destructive clear until embeddings are confirmed available, so a failed reconciliation does not leave search fully blank. Ensure a documented operator path (or health-driven retry) exists to resume reconciliation after a `pending` result.

## Security

No issues found. Restore preserves the existing checksum integrity check (`src/backup/index.ts:96-100`), the restore guard prevents concurrent restores (`src/backup/index.ts:149-161`), and reconciliation reuses existing Qdrant write primitives with no new external input surface.

## Maintainability & code quality

### [Low · Medium · S] Backup format still SQLite-only with no vector/manifest metadata — `src/backup/index.ts:23-64`

**Issue:** `create()` writes a version-1 header (`memory_count`, `checksum`, `embedding_model`, `embedding_dimensions`) plus raw SQLite bytes. It does not snapshot vectors and the header has no field describing the dual-store reconciliation contract. The proposal reframes backup/restore as a dual-store workflow, but the *backup* side intentionally stays single-store (an accepted Non-Goal) — that intent is not recorded anywhere in the backup code, so a future reader may mistake the omission for a bug.

**Why it matters:** This is the most likely source of confusion/drift across the three overlapping proposals (`fix-backup-restore-runtime-consistency`, `harden-post-restore-reconciliation`, this one), which all touch the same restore path. Undocumented intent invites re-litigation.

**Recommendation:** Add a brief comment (and/or a header flag like `vectors: "rebuilt-on-restore"`) stating that backups are deliberately SQLite-only and vectors are reconstructed from SQLite on restore. No behavior change required.

## Testing & coverage

### [Low · Medium · S] Reconciliation cursor/pagination not directly tested — `src/storage/index.ts:204-258`

**Issue:** Backup tests mock `reconcileVectorsFromSqlite` entirely (`src/backup/index.test.ts:40,62`), so the real batched loop — cursor construction `${created_at}|${id}` (`src/storage/index.ts:254`), multi-batch advancement, the `memories.length < batchSize` break, and the mid-loop `markVectorSync` durability — is not exercised by a test. Health and backup behavior around it are covered, but the loop itself is not.

**Why it matters:** The cursor logic is the part most prone to subtle correctness bugs (skipping rows, re-processing, or non-termination) and is exactly the code that re-embeds the corpus. It is currently unverified.

**Recommendation:** Add a `src/storage/index.test.ts` (or extend an existing storage test) that drives `reconcileVectorsFromSqlite` over a fake SQLite/Qdrant/embedding with more rows than one batch, asserting every row is upserted once and `remaining` reaches 0.

## Dependencies & supply chain

No issues found. The change introduces no new dependencies; it reuses `node:crypto` (sha256 checksum), the existing embedding client, and the existing Qdrant client primitives.

## Recommendations (prioritized)

1. **(Stability, Finding 2)** Bound or background the reconciliation loop so a slow embedding provider cannot hold the restore call/lifecycle lock open indefinitely; let health drive the `reconciling → reconciled` transition.
2. **(Performance, Finding 1)** Resolve the design Open Question — gate the full clear+re-embed behind a size threshold or delta check so no-drift / large restores are not always O(N) embeddings.
3. **(Stability, Finding 3)** Narrow or defer the destructive `clearManagedVectors()` so a failed reconciliation does not leave search fully blank; ensure a documented retry path for `pending`.
4. **(Logging, Finding 4)** Emit per-batch progress and total duration during reconciliation.
5. **(Testing, Finding 6)** Add a direct multi-batch test for `reconcileVectorsFromSqlite`.
6. **(Maintainability, Finding 5)** Document the intentional SQLite-only backup format and vectors-rebuilt-on-restore contract in code/header.
