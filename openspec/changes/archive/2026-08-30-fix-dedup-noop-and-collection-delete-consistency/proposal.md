## Why

High-severity audit findings show two correctness defects that can silently corrupt user expectations: near-duplicates classified as `NOOP` are still persisted as new memories, and collection deletion removes only metadata while leaving memory/vector data orphaned. These issues directly impact data quality, trust, and storage integrity, so they should be fixed before further feature expansion.

## What Changes

- Add explicit `NOOP` handling in the write decision pipeline so high-confidence near-duplicates do not create new rows/vectors.
- Return canonical metadata for `NOOP` decisions (existing memory id/summary/type/timestamp) without mutating stored content.
- Redefine collection deletion behavior to be consistent and enforceable: delete operations must not leave orphaned SQLite or Qdrant data.
- Implement safe delete semantics for collections (reject non-empty collections unless explicitly forced, or perform full cascade by namespace/collection across both stores).
- Ensure collection deletion updates audit/metrics consistently with memory deletion outcomes.

## Capabilities

### New Capabilities
- `write-dedup-noop-correctness`: Ensure `NOOP` dedup classification is terminal and non-mutating.
- `collection-deletion-consistency`: Enforce collection deletion semantics that keep metadata, memories, and vectors consistent.

### Modified Capabilities
- None.

## Impact

- Affected code: `src/pipeline/index.ts`, `src/tools/index.ts`, `src/storage/index.ts`, `src/storage/sqlite.ts`, `src/storage/qdrant.ts`.
- API behavior: `remember` and `collections` tool behavior becomes deterministic and consistency-preserving.
- Data/storage: Prevents duplicate growth and orphaned vector/data artifacts.
