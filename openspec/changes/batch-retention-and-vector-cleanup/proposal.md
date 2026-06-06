## Why

Retention cleanup and collection deletion currently do too much work one item at a time and can silently leave Qdrant state behind. That creates poor cleanup throughput and cross-store drift in the exact workflows responsible for garbage cleanup.

## What Changes

- Define batched retention GC semantics that reduce per-memory flush and network overhead.
- Define fail-safe collection deletion semantics so SQLite and Qdrant cannot silently diverge.
- Require explicit visibility when vector cleanup fails.

**Audit follow-ups (2026-06-05):** The audit found the "no silent divergence" guarantee only half-built — the silent-failure mode was relocated, not removed.
- The batched GC delete (`deleteMemories`) must return a structured degraded result with the unreconciled memory ids on a transient Qdrant error mid-batch, instead of throwing a generic internal error after archive rows were already written; SQLite rows are removed only for confirmed vector deletions.
- A failed collection-vector cleanup must record a detectable tombstone / drift signal (rows not left `vector_synced=true`) and emit a health/log signal — today it preserves SQLite rows but `unsynced_vectors` still reports zero drift.
- Partial-failure paths (transient Qdrant error mid-batch; failed vector cleanup) gain test coverage; the current GC test stubs `deleteMemories` to always succeed.

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
