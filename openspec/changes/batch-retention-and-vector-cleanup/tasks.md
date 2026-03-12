## 1. Retention Throughput

- [x] 1.1 Add storage APIs that support batched archive, audit, and SQLite delete behavior.
- [x] 1.2 Refactor retention GC to avoid per-memory flushes and unnecessary sequential persistence overhead.

## 2. Vector Cleanup Consistency

- [x] 2.1 Make Qdrant collection deletion fail closed for non-not-found errors.
- [x] 2.2 Preserve enough reconciliation state to retry or report vector cleanup failures safely.

## 3. Verification

- [x] 3.1 Add tests for high-volume GC behavior and partial failure handling.
- [x] 3.2 Add tests for collection deletion when Qdrant returns transient errors.
