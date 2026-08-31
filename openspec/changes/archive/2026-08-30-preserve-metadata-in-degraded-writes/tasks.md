## 1. Storage Path Unification

- [x] 1.1 Add a storage API for SQLite-only degraded writes that still records collection metadata.
- [x] 1.2 Apply normal collection compatibility checks in degraded mode.

## 2. Pipeline Refactor

- [x] 2.1 Replace direct SQLite fallback writes in the pipeline with the new storage path.
- [x] 2.2 Preserve explicit unsynced state for later reconciliation.

## 3. Verification

- [x] 3.1 Add tests for degraded writes into new and existing collections.
- [x] 3.2 Add tests for later repair/reconciliation preconditions.
