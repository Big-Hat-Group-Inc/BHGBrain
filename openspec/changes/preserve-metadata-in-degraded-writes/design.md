## Context

Normal writes go through `StorageManager.writeMemory()`, which creates collection metadata and enforces embedding compatibility. Degraded-mode fallback writes currently bypass that path and insert directly into SQLite.

## Goals / Non-Goals

**Goals:**
- Preserve collection registration during degraded writes.
- Keep unsynced rows repairable later.
- Retain embedding-space compatibility checks.

**Non-Goals:**
- Implementing the full reconciliation worker in this change unless needed for verification.
- Changing degraded-mode startup policy.

## Decisions

1. Route degraded writes through a metadata-preserving storage path.
- The path may skip Qdrant upsert but still creates or validates collection metadata.

2. Keep unsynced status explicit.
- Fallback records remain marked unsynced for later reconciliation and health reporting.

3. Reuse normal compatibility checks.
- Collection model/dimension validation still applies in degraded mode.

## Risks / Trade-offs

- [Fallback path becomes slightly more complex] -> Mitigation: centralize logic in storage rather than duplicating it in pipeline.
- [Existing degraded tests may need adjustment] -> Mitigation: add targeted regression cases.

## Migration Plan

- Introduce a storage-level degraded write path.
- Refactor pipeline fallback to use it.
- Add tests for collection creation and compatibility in degraded mode.
