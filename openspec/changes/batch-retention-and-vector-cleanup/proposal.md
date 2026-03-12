## Why

Retention cleanup and collection deletion currently do too much work one item at a time and can silently leave Qdrant state behind. That creates poor cleanup throughput and cross-store drift in the exact workflows responsible for garbage cleanup.

## What Changes

- Define batched retention GC semantics that reduce per-memory flush and network overhead.
- Define fail-safe collection deletion semantics so SQLite and Qdrant cannot silently diverge.
- Require explicit visibility when vector cleanup fails.

## Capabilities

### New Capabilities
- `retention-gc-throughput`: Retention cleanup batches persistence and vector cleanup work.
- `collection-vector-reconciliation`: Collection deletion preserves or restores cross-store consistency when vector cleanup fails.

### Modified Capabilities
- `retention-and-degradation`: Cleanup behavior gains stronger consistency and throughput guarantees.

## Impact

- Affected code: `src/backup/retention.ts`, `src/storage/index.ts`, `src/storage/qdrant.ts`, `src/health/index.ts`.
- Performance: reduces write amplification and network round-trips during cleanup.
- Stability: removes silent orphan-vector failure modes.
