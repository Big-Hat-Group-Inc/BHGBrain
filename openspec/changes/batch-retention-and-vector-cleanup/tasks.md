## 1. Retention Throughput

- [x] 1.1 Add storage APIs that support batched archive, audit, and SQLite delete behavior.
- [x] 1.2 Refactor retention GC to avoid per-memory flushes and unnecessary sequential persistence overhead.

## 2. Vector Cleanup Consistency

- [x] 2.1 Make Qdrant collection deletion fail closed for non-not-found errors.
- [x] 2.2 Preserve enough reconciliation state to retry or report vector cleanup failures safely.

## 3. Verification

- [x] 3.1 Add tests for high-volume GC behavior and partial failure handling.
- [x] 3.2 Add tests for collection deletion when Qdrant returns transient errors.

## Audit follow-ups (2026-06-05)

- [x] 4.1 Give `deleteMemories` (`src/storage/index.ts:133-149`) explicit GC failure visibility. The per-group Qdrant `deleteMany` has no try/catch and the method returns only a count, so a transient Qdrant error mid-batch throws a generic `INTERNAL` out of `runGc` *after* archive rows were already written (`retention.ts:54-59`) — the exact silent-divergence mode this change set out to remove, relocated into the GC batch path. Wrap the per-group delete so a transient Qdrant error yields a structured degraded result carrying the set of unreconciled memory ids; delete SQLite rows only for ids whose vectors were confirmed removed, and propagate `degraded` + `unreconciled` ids up through `GarbageCollectionResult` so `runGc` can report partial failure instead of an opaque internal error.
- [x] 4.2 Make a failed collection-vector cleanup detectable. Today `deleteCollectionData` (`src/storage/index.ts:155-163`) correctly preserves SQLite rows on a non-not-found Qdrant error, but records NO tombstone and surfaces NO health/log signal: surviving rows keep `vector_synced = true`, so `unsynced_vectors` (`src/health/index.ts:53,114`) reports zero drift even though Qdrant may now be partially deleted/orphaned. On a non-not-found `deleteCollection` failure, persist a narrow tombstone (or mark affected rows `vector_synced=false`) and emit a `warn` log/metric so `checkVectorReconciliation` (`src/health/index.ts:113-140`) and operators can see and retry the residual cleanup.
- [x] 4.3 Add partial-failure tests. The current GC test (`src/backup/retention.test.ts:65-96`) stubs `deleteMemories` to always succeed, so the failure path is untested. Add a case where `deleteMemories` reports a transient Qdrant failure mid-batch, asserting `runGc` returns a degraded result with the unreconciled ids and does not silently flush a fully clean pass; add a case asserting a failed collection-vector cleanup leaves a detectable tombstone / drift signal (rows not `vector_synced=true`).
