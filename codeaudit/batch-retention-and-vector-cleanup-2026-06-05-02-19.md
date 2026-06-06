# Code Audit — OpenSpec proposal `batch-retention-and-vector-cleanup`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `batch-retention-and-vector-cleanup`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 10 (`src/backup/retention.ts`, `src/backup/retention.test.ts`, `src/storage/index.ts`, `src/storage/index.test.ts`, `src/storage/qdrant.ts`, `src/storage/sqlite.ts` [relevant methods], `src/tools/index.ts` [collection delete], `src/tools/index.test.ts`, `src/health/index.ts`, proposal/design/tasks/specs)

## Executive summary

The change delivers most of its stated intent: retention GC now batches Qdrant deletes through a single `deleteMemories()` call grouped by namespace/collection and performs exactly one SQLite flush per pass (`retention.ts:61-66`), and forced collection deletion now fails closed — `QdrantStore.deleteCollection()` swallows only not-found errors and rethrows everything else (`qdrant.ts:214-224`), which propagates out of `deleteCollectionData()` before the SQLite collection row is dropped (`tools/index.ts:208-219`). Both behaviors are tested.

However, two requirements are only partially met. First, the **failure-visibility** requirement for GC (`specs/retention-gc-throughput`) is not satisfied: `deleteMemories()` has no try/catch around the Qdrant batch and no per-memory failure tracking, so a transient Qdrant error throws out of `runGc()` as a generic `INTERNAL` error after archive rows were already written, with no degraded result and no way for operators to identify which items remain unreconciled. Second, design Decision 3 ("preserve reconciliation data / tombstone state until vector cleanup succeeds") is implemented only implicitly — surviving SQLite rows act as the retry record, but there is no explicit tombstone, no health-visible signal for orphaned vectors after a failed collection delete, and `vector_synced` remains `true` so the existing drift gauge stays silent. There is also a resilience inconsistency: the new `deleteMany()` and the `deleteCollection()` paths bypass the circuit breaker that every other Qdrant call uses.

No security regressions found. Namespace/collection scoping is preserved throughout the new batch paths.

## Spec compliance

| Requirement / Task | Status | Evidence |
| --- | --- | --- |
| Req: Retention GC must batch persistence work | Done | `retention.ts:61` single `deleteMemories(..., {flush:false})`; audits with `{flush:false}` (`:63`); one `flushIfDirty()` per pass (`:66`); `deleteMemories` groups by ns/collection and issues one `deleteMany` per group (`storage/index.ts:125-136`) |
| Req: Retention GC must preserve failure visibility | Missing | `deleteMemories` (`storage/index.ts:133-136`) has no try/catch and returns only a count; a Qdrant batch error throws out of `runGc` as generic `INTERNAL`; `GarbageCollectionResult` (`retention.ts:7-17`) has no degraded/failed/unreconciled fields; archive rows already written at `:54-59` are not rolled back |
| Req: Collection deletion must not silently orphan vectors | Done | `qdrant.ts:214-224` rethrows non-not-found; `deleteCollectionData` (`storage/index.ts:155-163`) deletes Qdrant before SQLite rows; tool surfaces the error and skips `sqlite.deleteCollection` (`tools/index.ts:208-219`, test `tools/index.test.ts:91-105`) |
| Req: Not-found vector cleanup may be treated as already clean | Done | `deleteCollection` returns on `isNotFoundError` (`qdrant.ts:219-221`); `deleteMany`/`delete` same (`:106-110`, `:123-126`) |
| Scenario: reconciliation data remains available for retry (collection) | Partial | SQLite rows survive a failed Qdrant collection delete, so retry is possible — but no explicit tombstone/reconciliation record (design Decision 3) and no health/log signal that Qdrant orphans exist; `vector_synced` is unchanged so `unsynced_vectors` (`health/index.ts:53,114`) does not flag it |
| Task 1.1 Batched archive/audit/SQLite delete APIs | Done | `deleteMemories` (`storage/index.ts:119-149`), `logAudit({flush:false})` (`:260-279`), `flushIfDirty` deferral |
| Task 1.2 Refactor GC to avoid per-memory flushes | Done | `retention.ts:54-66` — no per-item flush; single pass-level flush |
| Task 2.1 Qdrant collection delete fails closed for non-not-found | Done | `qdrant.ts:214-224` |
| Task 2.2 Preserve reconciliation state to retry/report vector failures | Partial | Implicit via surviving SQLite rows; no explicit tombstone and no reporting surface for the collection-orphan case (see Stability findings #2/#3) |
| Task 3.1 Tests for high-volume GC + partial failure handling | Partial | `retention.test.ts:65-96` covers batched happy path only; `deleteMemories` is mocked to always succeed, so the GC partial-failure path (Qdrant batch error mid-pass) is untested |
| Task 3.2 Tests for collection delete on transient Qdrant errors | Done | `tools/index.test.ts:91-105` asserts error surfaced and `sqlite.deleteCollection` not called |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | High | High | M | Stability | `storage/index.ts:133-149` | GC batch delete has no failure visibility; throws generic error after archives written, no unreconciled set |
| 2 | Medium | High | M | Stability | `storage/index.ts:155-163`, `health/index.ts:53` | Failed collection vector cleanup leaves no explicit tombstone / health signal for orphaned vectors |
| 3 | Medium | High | S | Stability | `qdrant.ts:114,214` | `deleteMany` and `deleteCollection` bypass the circuit breaker used by all other Qdrant calls |
| 4 | Medium | High | S | Testing | `backup/retention.test.ts:65-96` | No test for GC partial-failure path; `deleteMemories` is stubbed to always succeed |
| 5 | Low | High | S | Logging | `backup/retention.ts:29-74` | `runGc` emits no structured log of scanned/archived/deleted/failed; cleanup drift not observable in logs |
| 6 | Low | Medium | S | Stability | `backup/retention.ts:54-61` | Archive rows written before batch delete are not rolled back if delete throws → duplicate archive rows on retry |

## Quick wins

- Route `deleteMany`/`deleteCollection` through `executeWithBreaker` (Finding #3, S).
- Add a Pino structured log line at the end of `runGc` with the result counts (Finding #5, S).
- Add a Vitest case where the mocked `deleteMemories` rejects, asserting `runGc` surfaces failure and does not flush a partial pass (Finding #4, S).

## Performance

No issues found. The core performance goal is met: GC issues one grouped `deleteMany` per namespace/collection and a single SQLite flush per pass instead of one flush + one audit flush per memory. `reconcileVectorsFromSqlite` (`storage/index.ts:204-258`) batches embeds and flushes per batch. The remaining O(n) audit-insert loop (`retention.ts:62-64`) is in-memory sql.js work with no per-row flush, which is acceptable for a GC pass.

## Logging & observability

### [Low · High · S] `runGc` produces no operator-facing record of a cleanup pass — `src/backup/retention.ts:29-74`

**Issue:** `runGc` returns a `GarbageCollectionResult` but emits no Pino log. There is no record of scanned/archived/deleted counts, no timing, and (because there is no failure path) no log when vector cleanup drifts. The spec requirement "operators can identify which cleanup work remains unreconciled" has no logging affordance.

**Why it matters:** GC is a background reconciliation task; without a structured log line operators cannot confirm passes ran, how much they cleaned, or whether a pass failed partway. Diagnosing orphaned vectors after the fact becomes guesswork.

**Recommendation:** Inject the Pino logger into `RetentionService` and emit one structured event per pass (`event: 'retention_gc'`, scanned/archived/deleted, and any failed/unreconciled ids), at `warn` level when failures occur.

## Stability & reliability

### [High · High · M] GC batch delete swallows the requirement for failure visibility — `src/storage/index.ts:133-149`

**Issue:** In `deleteMemories`, the per-group Qdrant `deleteMany` (`:133-136`) is not wrapped in try/catch and the method returns only a numeric count. A transient Qdrant error on any group throws straight out of `runGc` as a generic `internal(...)` (via the `deleteMany`→`upsert` breaker path or the raw rethrow), so: (a) the caller gets no degraded/failed result distinguishing "nothing cleaned" from "half cleaned," (b) groups already deleted in Qdrant before the failure now have their SQLite rows un-deleted (the SQLite delete loop at `:138-143` hasn't run yet), and (c) archive rows written at `retention.ts:54-59` persist. The spec requires GC to "report the failure as degraded or failed work" and let operators "identify which cleanup work remains unreconciled." Neither is implemented.

**Why it matters:** This is the exact silent-divergence failure mode the proposal set out to remove, relocated from collection delete into the batch GC path. A partial Qdrant outage during GC yields an opaque error and a half-reconciled store with no machine-readable record of what remains.

**Recommendation:** Have `deleteMemories` collect per-group/per-id outcomes and return a structured result (`deleted`, `failedIds`, `degraded`). Delete SQLite rows only for ids whose vectors were confirmed removed, and surface `degraded`/`failedIds` up through `GarbageCollectionResult` so `runGc` can report partial failure and operators can retry the residual set.

### [Medium · High · M] Failed collection vector cleanup leaves no explicit reconciliation/health signal — `src/storage/index.ts:155-163`, `src/health/index.ts:53`

**Issue:** When `deleteCollection` rethrows a transient error, `deleteCollectionData` correctly preserves SQLite rows (fail-closed), satisfying "fails closed." But design Decision 3 calls for explicit tombstone/reconciliation state, and there is none: the surviving rows still have `vector_synced = true`, so the health drift gauge `unsynced_vectors` (`health/index.ts:53,114`) reports zero drift even though Qdrant may now be partially deleted/orphaned. No log or metric records the failed collection cleanup.

**Why it matters:** The spec scenario promises "reconciliation data remains available for retry" and operators able to identify unreconciled work. Retry is possible (rows exist) but invisible — nothing tells an operator a collection delete failed mid-flight or that Qdrant orphans may exist, so the drift can sit undetected until the next manual delete attempt.

**Recommendation:** On a non-not-found `deleteCollection` failure, persist a narrow tombstone (or mark affected rows `vector_synced=false`) and emit a `warn` log/metric, so `checkVectorReconciliation` (`health/index.ts:113-140`) and operators can see and retry the residual cleanup.

### [Medium · High · S] `deleteMany`/`deleteCollection` bypass the circuit breaker — `src/storage/qdrant.ts:114,214`

**Issue:** `upsert`, `delete`, `search`, `clearManagedCollections` all call through `executeWithBreaker` (`qdrant.ts:83,98,158,304`), but the new batch `deleteMany` (`:114-128`) and `deleteCollection` (`:214-224`) call `this.client.*` directly with no breaker.

**Why it matters:** During a Qdrant outage these new cleanup paths do not benefit from the circuit breaker — they will hammer a failing Qdrant and produce raw client errors instead of the normalized "circuit breaker is open" `internal(...)`, undermining the resilience contract the codebase otherwise enforces uniformly.

**Recommendation:** Wrap both methods in `executeWithBreaker(...)` as the other mutating Qdrant calls do, preserving the existing `isNotFoundError` handling inside the callback.

### [Low · Medium · S] Archive rows are written before batch delete and not rolled back on failure — `src/backup/retention.ts:54-61`

**Issue:** `runGc` writes archive rows in a loop (`:54-59`) and only afterward calls `deleteMemories` (`:61`). If the batch delete throws, the archive rows are already in memory; the pass-level `flushIfDirty` at `:66` is skipped (exception), but a *later* successful operation flushes them, and a subsequent GC retry archives the same memories again — `archiveMemory` (`sqlite.ts:773-788`) is an unconditional `INSERT` with no dedupe on `memory_id`.

**Why it matters:** Repeated failures-then-retries can accumulate duplicate archive rows for the same memory, inflating archive counts and search results.

**Recommendation:** Stage archive writes and the delete in a single recoverable step, or make `archiveMemory` upsert on `memory_id`; only archive memories whose deletion is confirmed.

## Security

No issues found. The batch paths preserve namespace+collection scoping: `deleteMemories` groups strictly by `namespace|collection` (`storage/index.ts:125-131`) and `collectionName` always prefixes both (`qdrant.ts:34-36`); the search filter still pins `namespace` (`qdrant.ts:144-146`). No secrets are logged; the Qdrant API key is still read indirectly via `api_key_env` (`qdrant.ts:20-22`).

## Maintainability & code quality

No blocking issues found. One observation tied to Finding #1: `deleteMemories` returns a bare `number` while its sibling `deleteCollectionData` returns a structured `{deleted, ids}` (`storage/index.ts:155`). Aligning `deleteMemories` on a structured result would both fix the visibility gap and make the two batch APIs consistent. The `key.split('|')` reconstruction (`:134`) is brittle if a namespace ever contains `|`; consider storing `{namespace, collection}` tuples in the map value rather than encoding into the key.

## Testing & coverage

### [Medium · High · S] GC partial-failure path is untested — `src/backup/retention.test.ts:65-96`

**Issue:** The only GC test stubs `storage.deleteMemories` to resolve `1` (`retention.test.ts:81`), exercising the happy path and asserting one flush and `{flush:false}` audits. There is no test where `deleteMemories` rejects (Qdrant batch failure mid-pass), which is precisely the "partial failure handling" called for in task 3.1 and the failure-visibility requirement.

**Why it matters:** The most consequential new behavior — what GC does when vector cleanup fails — has no regression coverage, so Finding #1 can regress silently.

**Recommendation:** Add a case with `deleteMemories` rejecting; assert `runGc` surfaces failure (or a degraded result once #1 is fixed) and does not silently flush a partial pass. Once `deleteMemories` returns structured failures, assert the unreconciled ids are reported.

## Dependencies & supply chain

No issues found. No new dependencies introduced; the change reuses `@qdrant/js-client-rest`, `uuid`, and the existing `CircuitBreaker`. (Finding #3 is about *using* the existing breaker, not a dependency concern.)

## Recommendations (prioritized)

1. **(High, M)** Make `deleteMemories` return structured per-id outcomes and only delete SQLite rows for confirmed vector removals; propagate a degraded/failed result and the unreconciled id set up through `runGc` (Findings #1, #6; satisfies the GC failure-visibility requirement and task 3.1).
2. **(Medium, S)** Route `deleteMany`/`deleteCollection` through `executeWithBreaker` (Finding #3).
3. **(Medium, M)** Record explicit reconciliation state + health/log signal when collection vector cleanup fails, so orphans are detectable and retryable (Finding #2; satisfies design Decision 3 / task 2.2 fully).
4. **(Medium, S)** Add GC partial-failure tests (Finding #4).
5. **(Low, S)** Emit a structured Pino log per GC pass including any failed ids (Finding #5).
