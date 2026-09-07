## Why

Several write, update, delete, and reconciliation paths can leave SQLite, FTS5, and Qdrant in contradictory states while their sync markers remain clean. These are the audit's most direct data-loss and silent-drift risks and must be resolved around one explicit SQLite-source-of-truth invariant.

## What Changes

- Make single and batched deletes preserve recoverable SQLite state until vector deletion is confirmed, with lifecycle-safe compensation and structured drift reporting.
- Make compound SQLite memory/FTS/link mutations transactional and add a bounded busy timeout for supported multi-process contention.
- Make T0 revision, audit, memory update, and rollback behavior atomic enough to avoid phantom history and masked errors.
- Synchronize metadata-only changes into Qdrant payloads and converge collection embedding metadata after re-embedding.
- Isolate reconciliation failures per item, classify permanent embedding failures, chunk large ID operations, and provide an operator-visible resume path.
- Idempotently ensure required Qdrant payload indexes and preserve lifecycle/provenance fields during degraded writes and repair.

## Capabilities

### New Capabilities
- `dual-store-mutation-consistency`: Defines safe mutation ordering, transactional local indexes, explicit cross-store drift, resumable reconciliation, and embedding-migration convergence.

### Modified Capabilities

## Impact

- Affected code: `src/storage/index.ts`, `src/storage/sqlite.ts`, `src/storage/qdrant.ts`, `src/pipeline/index.ts`, `src/search/index.ts`, `src/tools/index.ts`, health reporting, and storage/reconciliation tests.
- Audit coverage: F1, F2, F4-F9, F22, F35, F37, F61, F68-F72, F76, F77, F82, and F84.
- Compatibility: public tool shapes remain stable except for more accurate error and degraded outcomes.
