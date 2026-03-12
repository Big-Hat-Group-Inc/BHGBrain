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

## Risks / Trade-offs

- [Batched GC is more complex than item-by-item deletion] -> Mitigation: isolate batch orchestration behind storage APIs and test partial failures.
- [Retry metadata increases state surface] -> Mitigation: keep reconciliation records narrow and auditable.

## Migration Plan

- Add batched delete/reconcile APIs.
- Update retention and collection delete flows.
- Extend health reporting for cleanup drift.
