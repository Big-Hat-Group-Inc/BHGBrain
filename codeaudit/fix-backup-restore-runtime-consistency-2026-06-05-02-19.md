# Code Audit — OpenSpec proposal `fix-backup-restore-runtime-consistency`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `fix-backup-restore-runtime-consistency`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 8 (`src/backup/index.ts`, `src/backup/index.test.ts`, `src/storage/index.ts`, `src/storage/sqlite.ts`, `src/domain/types.ts`, `src/tools/index.ts`, `README.md`, proposal/spec/design/tasks)

## Executive summary

The proposal is **substantially implemented and well-tested**. The core defect it targets — restore writing bytes to disk while the running process keeps stale in-memory `sql.js` state — is genuinely fixed: `BackupService.restore` now calls `storage.reloadSqliteFromDisk()` after checksum-validated write, serializes restore via a lifecycle guard, fails loudly on activation error, and returns an activation indicator. The implementation went beyond the spec by adding vector reconciliation, which is a net positive but introduces the report's only stability concern (a non-atomic disk-then-vector window). Overall health is good. There are **no Critical/High findings**. The single most actionable item is a **documentation drift** (Medium): the README documents a restore response field `activated: true` that the code does not emit — the real field is `metadata_activated`. Headline counts: 0 Critical, 0 High, 2 Medium, 4 Low.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Req: Restore success activates restored state | Done | `src/backup/index.ts:109` calls `reloadSqliteFromDisk`; `src/storage/sqlite.ts:285-300` closes old handle, re-reads bytes from `dbPath`, rebuilds DB. |
| Scenario: restored bytes loaded, reads return restored data without restart | Done | `src/backup/index.ts:103-104,119` write then reload then `countMemories()` from new handle; test `src/backup/index.test.ts:24-65`. |
| Req: Restore failure must not report false success | Done | `src/backup/index.ts:107-117` wraps reload; on throw emits `backup_restore_activate_failed` and rethrows `internal(...)`; test `src/backup/index.test.ts:150-176`. |
| Scenario: activation fails after write → error + operator guidance | Partial | Error is returned (`src/backup/index.ts:116`), but the message `Backup restore activation failed: <reason>` carries no explicit operator action (e.g. "restart required" / restart-required fallback the design left open). Design §1 alternative `restart_required` was not implemented. |
| Req: Restore response communicates activation outcome | Done (field-name drift) | `RestoreResult` (`src/domain/types.ts:110-114`) returns `memory_count` + `metadata_activated` + `vector_reconciliation`; returned at `src/backup/index.ts:130-134`. Spec satisfied, but README names the field `activated` (drift — see Finding 1). |
| Task 1.1 storage-level reload to re-open SqliteStore from disk | Done | `src/storage/sqlite.ts:285-300`, `src/storage/index.ts:165-167`. |
| Task 1.2 restore invokes reload after checksum-validated write | Done | `src/backup/index.ts:98-109`. |
| Task 1.3 serialize restore to prevent concurrent mutation | Done | `beginRestoreOperation` + `beginLifecycleOperation('restore')` (`src/backup/index.ts:83,149-161`; `src/storage/sqlite.ts:1093-1099`); test `src/backup/index.test.ts:225-259`. |
| Task 2.1 extend result payload with activation metadata | Done | `src/domain/types.ts:110-114`; `src/backup/index.ts:130-134`. |
| Task 2.2 explicit failure when activation fails | Done | `src/backup/index.ts:110-117`; test `src/backup/index.test.ts:150-176`. |
| Task 2.3 structured logs for validate/write/activate/complete/fail phases | Done | `backup_restore_validate` (`:85`), `_write` (`:105`), `_activate_start` (`:108`), `_activate_failed` (`:111`), `_complete` (`:121`). |
| Task 3.1 tests: restored data visible after success | Done | `src/backup/index.test.ts:24-65`. |
| Task 3.2 tests: activation-failure paths (no false success) | Done | `src/backup/index.test.ts:150-176`. |
| Task 3.3 update backup/restore docs with runtime activation behavior | Drifted | README §2595-2597 documents runtime activation, but the response example uses `activated: true` (`README.md:1553,1631,1633,2309,2595`) which does not match the emitted `metadata_activated`. |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | Medium | High | S | Maintainability | `README.md:1553,1631,1633,2309,2309` vs `src/domain/types.ts:112` | Docs advertise restore field `activated`; code emits `metadata_activated`. |
| 2 | Medium | Medium | M | Stability | `src/backup/index.ts:104-120` | Disk replaced + in-memory vectors cleared before reconciliation; a crash/failure leaves SQLite restored but Qdrant emptied (degraded), recoverable only by repair. |
| 3 | Low | Medium | S | Stability | `src/backup/index.ts:138-145` | If `endLifecycleOperation('restore')` throws on mismatch, the original restore error is masked by the finally-block throw. |
| 4 | Low | High | S | Stability | `src/storage/sqlite.ts:289-296` | `reloadFromDisk` closes the live DB handle before re-reading; if `readFileSync` fails the store is left with a closed/undefined `db` and no rollback. |
| 5 | Low | Low | S | Logging | `src/backup/index.ts:116` | Activation-failure error returned to operator lacks explicit remediation (restart guidance / restart-required fallback from design). |
| 6 | Low | Medium | M | Performance | `src/storage/index.ts:221` | Restore reconciliation re-embeds every restored memory (full embed cost) rather than reusing any stored vectors; expected but worth noting for large DBs. |

## Quick wins

- **Finding 1** (S): align README restore examples to the actual `metadata_activated` field (or add an `activated` alias to `RestoreResult`). One-field doc fix; removes an integrator-facing contract lie.
- **Finding 3** (S): wrap the `endLifecycleOperation` call in the finally so a cleanup throw cannot mask the real restore error.

## Performance

### [Low · Medium · M] Restore re-embeds all restored memories — `src/storage/index.ts:221`
**Issue:** After activation, `reconcileVectorsFromSqlite` marks all memories `vector_synced=0`, clears managed Qdrant collections, then re-embeds every memory in batches (`embedBatch` at `src/storage/index.ts:221`) to rebuild vectors. For a large restored DB this is a full re-embedding pass (network + embedding-provider cost) on every restore.
**Why it matters:** Restore latency and embedding-API cost scale linearly with memory count; a restore of a large brain could be slow and expensive, and is fully serialized under the restore lifecycle lock (all writes blocked meanwhile).
**Recommendation:** Acceptable for the proposal's scope (the spec only required SQLite activation). If restore of large datasets becomes common, consider persisting vectors in the backup payload or skipping re-embed when the embedding model/dimensions in the backup header match current config (the header already records `embedding_model`/`embedding_dimensions` at `src/backup/index.ts:39-40`, but `restore` does not read them).

## Logging & observability

### [Low · Low · S] Activation-failure response lacks operator remediation — `src/backup/index.ts:116`
**Issue:** The spec scenario "activation step fails after file write" requires the response to "include actionable operator guidance." The thrown error is `Backup restore activation failed: <reason>` with no next-step (e.g. "the on-disk DB was replaced; restart the service to load it"). The design also left a `restart_required` fallback as an explicit alternative, which is not implemented.
**Why it matters:** On activation failure the bytes on disk are already the restored ones, so a restart would actually recover — but the operator is not told this, undermining the spec's "actionable guidance" requirement.
**Recommendation:** Enrich the error message (or add a `required_action` field) noting that the file was written and a restart will activate it, fulfilling the design's restart-required fallback.

Otherwise, phase logging is complete and well-structured (validate/write/activate_start/activate_failed/complete, plus per-step vector-reconciliation warnings at `src/backup/index.ts:215-218`). No PII/secret leakage observed.

## Stability & reliability

### [Medium · Medium · M] Non-atomic disk-then-vector window leaves Qdrant emptied on partial failure — `src/backup/index.ts:104-120`
**Issue:** Restore order is: (1) `atomicWriteFileSync(dbPath, …)` (`:104`), (2) `reloadSqliteFromDisk` (`:109`), (3) `markAllMemoriesVectorSync(false)` (`:165`), (4) `clearManagedVectors()` — deletes all managed Qdrant collections (`:171`), (5) re-embed/reconcile (`:189`). If step 5 fails or the process crashes between 4 and 5, SQLite is correctly restored but Qdrant has been wiped, leaving semantic search broken until a later reconcile/repair. The code does handle this gracefully by returning a `degraded`/`pending` `vector_reconciliation` (`src/backup/index.ts:190-205`) rather than failing — so it is *reported*, not silent — but the destructive `clearManagedVectors` happens before any replacement vectors exist.
**Why it matters:** A restore that the operator initiated to *recover* data can transiently degrade vector search to zero results, and a mid-reconcile crash persists that degraded state. This is the consistency surface the proposal exists to harden.
**Recommendation:** This is documented behavior (README:2597) and progress is flushed incrementally, so it is defensible. To tighten: reconcile into fresh collections and swap, or skip the `clearManagedVectors` wipe when reconciliation cannot proceed (Qdrant unreachable), so an unreachable vector store does not first get emptied. At minimum, keep the current degraded-status reporting and ensure the operator-facing message names the recovery path (`repair`).

### [Low · Medium · S] Finally-block cleanup can mask the original restore error — `src/backup/index.ts:138-145`
**Issue:** In the `finally`, `this.storage.sqlite.endLifecycleOperation('restore')` is called. `endLifecycleOperation` throws on a mismatched/absent lifecycle reason (`src/storage/sqlite.ts:1101-1106`). If it throws, that throw propagates from `finally` and replaces whatever error the `try`/`catch` was already throwing (e.g. an activation failure), obscuring root cause. `restoreInProgress` is still reset by the inner `finally`, so state is consistent, but the surfaced error may be wrong.
**Why it matters:** Operators could see a confusing "Mismatched lifecycle operation end" instead of the real "activation failed" reason.
**Recommendation:** Guard the `endLifecycleOperation` call (try/catch that logs at warn and does not rethrow) so the primary error always wins.

### [Low · High · S] reloadFromDisk closes the live handle before confirming new bytes load — `src/storage/sqlite.ts:289-296`
**Issue:** `reloadFromDisk` does `this.db.close()` (`:290`), checks `existsSync` (`:292`), then `readFileSync` + `new SQL.Database(buffer)` (`:295-296`). The existence check is after the close, and if `readFileSync` or `SQL.Database(buffer)` throws (corrupt/partial file), the old handle is already closed and `this.db` is left referencing a closed object with no rollback. Subsequent reads would fail. In the restore path the bytes were just checksum-validated and atomically written, so in practice the buffer is valid; the risk is reduced but the method is not self-protecting for other callers.
**Why it matters:** The reload primitive is the linchpin of "runtime consistency"; a failure mid-reload leaves the store unusable rather than retaining the previous good state.
**Recommendation:** Read the buffer and construct the new `SQL.Database` *before* closing the old handle, then swap and close the old one only on success; on failure keep the existing handle.

## Security

No issues found. Restore validates a SHA-256 checksum before activation (`src/backup/index.ts:96-100`), uses `atomicWriteFileSync`, parses a length-prefixed header, and is reachable only through the authenticated `backup` tool (`src/tools/index.ts:274-276`). No new secrets, injection, or path-traversal surface introduced by this change (`backupPath` is operator-supplied to an authenticated tool, consistent with existing backup semantics).

## Maintainability & code quality

### [Medium · High · S] README documents restore field `activated`, code emits `metadata_activated` — `README.md:1553,1631,1633,2309` vs `src/domain/types.ts:112`
**Issue:** Per CLAUDE.md, README is the user-facing contract and must stay in sync. The README states restore returns `{ memory_count, activated: true }` (e.g. `README.md:2309`, sequence diagram `:1553`, prose `:1633`, `:2595`). The actual `RestoreResult` (`src/domain/types.ts:110-114`) and the returned object (`src/backup/index.ts:130-134`) expose `metadata_activated` and `vector_reconciliation` — there is no `activated` key (`grep` for `metadata_activated` in README returns nothing; `activated` appears only as the documented-but-unimplemented name). The spec requirement ("explicit activation indicator") is met by `metadata_activated`, so this is a doc/code drift, not a spec gap.
**Why it matters:** An integrator coding against the documented `activated` field will read `undefined` and may treat every restore as un-activated.
**Recommendation:** Update README to `metadata_activated` and document `vector_reconciliation`, or add an `activated` alias field to `RestoreResult` for back-compat. Cheapest fix is the doc update.

Code quality is otherwise good: `BackupService` is cohesive, vector-reconciliation branches are factored into small private helpers (`restoreVectorStateAfterActivation`, `reconcileVectorsAfterRestore`, `toPendingVectorReconciliation`), and the lifecycle guard pattern is reused consistently.

## Testing & coverage

No issues found — coverage of the proposal's behavior is strong. `src/backup/index.test.ts` exercises: successful activation + reconciliation (`:24-65`), pending reconciliation when embeddings unavailable (`:67-107`), pending when vector-clear fails (`:109-148`), activation failure rethrow + guard release (`:150-176`), guard release when acquisition fails (`:180-223`), and concurrent-restore serialization (`:225-259`). Lifecycle begin/end calls are asserted. 

Optional gaps (Low, not blocking): no test asserts that after a *real* reload `countMemories()` reflects the restored file's content end-to-end (tests mock `reloadSqliteFromDisk`); and no test covers Finding 4 (reload failure leaving a closed handle) at the `SqliteStore.reloadFromDisk` unit level. Adding one integration test that writes a real backup, restores, and reads back restored rows would directly validate the spec's "reads return restored data without restart" scenario against real `sql.js` rather than mocks.

## Dependencies & supply chain

No issues found. The change introduces no new dependencies; it uses existing `node:crypto`, `node:fs`, `sql.js`, and the in-house Qdrant/embedding layers already vetted elsewhere.

## Recommendations (prioritized)

1. **Fix the README/contract drift (Finding 1, Medium, S):** rename documented `activated` → `metadata_activated` (and document `vector_reconciliation`), or add an `activated` alias to `RestoreResult`. User-facing contract correctness per CLAUDE.md.
2. **Harden `reloadFromDisk` ordering (Finding 4, Low, S):** construct the new DB before closing the old handle so a failed reload retains the previous good state.
3. **Make the finally cleanup non-masking (Finding 3, Low, S):** guard `endLifecycleOperation` so it cannot overwrite the primary restore error.
4. **Add operator remediation to activation-failure (Finding 5 / spec Partial, Low, S):** state that the file is written and a restart will activate it (the design's restart-required fallback), satisfying the spec's "actionable guidance" requirement fully.
5. **Reduce the Qdrant-wipe window (Finding 2, Medium, M):** avoid `clearManagedVectors` when Qdrant is unreachable, or reconcile-then-swap, to prevent a recovery action from transiently zeroing vector search.
6. **Add one real-`sql.js` restore round-trip test (Testing, Low, M):** validate restored rows are readable without restart end-to-end, not just against mocks.
