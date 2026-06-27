## Context

`RetentionService.runGc()` loops over expired memories and flushes/audits repeatedly through `StorageManager.deleteMemory()`. Collection deletion also commits SQLite deletion before attempting Qdrant cleanup, and current Qdrant collection deletion ignores all failures.

## Goals / Non-Goals

**Goals:**
- Batch cleanup work where practical.
- Avoid silent orphan vectors.
- Surface cleanup drift in health and logs.

**Non-Goals:**
- Replacing Qdrant.
- Changing retention policy thresholds.

## Decisions

1. Batch local persistence work per GC pass.
- Archive rows, audit rows, and SQLite deletions are staged and flushed once per batch or pass.

2. Treat vector cleanup failures as explicit outcomes.
- Only "collection not found" is ignorable; other errors produce a failed or degraded result.

3. Preserve reconciliation data until vector cleanup succeeds.
- Collection deletion keeps enough metadata or tombstone state to retry cleanup safely.

4. (Audit follow-up 2026-06-05) Batched GC delete returns a structured degraded result, not a bare count.
- `deleteMemories` (`src/storage/index.ts:133-149`) currently has no try/catch and returns only a count, so a transient Qdrant error mid-batch throws a generic `INTERNAL` out of `runGc` after archive rows are written — the silent-divergence mode this change set out to remove, relocated into the GC path. Wrap the per-group `deleteMany`; on a transient failure return `{ deleted, unreconciled: ids, degraded: true }`. Delete SQLite rows only for confirmed vector removals, leaving unreconciled memories detectable (not `vector_synced=true`), and propagate the degraded result up through `GarbageCollectionResult`.

5. (Audit follow-up 2026-06-05) Decision 3's tombstone must be explicit, not implicit.
- Today a failed collection-vector cleanup preserves SQLite rows but records no tombstone and emits no signal; surviving rows keep `vector_synced=true`, so `unsynced_vectors` (`src/health/index.ts:53,114`) reports zero drift. On a non-not-found `deleteCollection` failure, persist a narrow tombstone (or mark affected rows `vector_synced=false`) and emit a `warn` log/metric so `checkVectorReconciliation` (`src/health/index.ts:113-140`) and operators can see and retry the residual cleanup.

## Risks / Trade-offs

- [Batched GC is more complex than item-by-item deletion] -> Mitigation: isolate batch orchestration behind storage APIs and test partial failures.
- [Retry metadata increases state surface] -> Mitigation: keep reconciliation records narrow and auditable.

## Migration Plan

- Add batched delete/reconcile APIs.
- Update retention and collection delete flows.
- Extend health reporting for cleanup drift.
