## Context

The recent restore work made SQLite activation and vector readiness explicit, but the restore flow still treats some post-activation vector steps as fatal even after restored metadata is already live in-process. The current reconciliation loop also records successful sync state in memory and only flushes at the end of the batch, which makes partial progress less durable than it should be when a later vector upsert fails.

This follow-up change needs to harden restore semantics without changing the broader SQLite-first recovery model. SQLite remains the restore source of truth, vector state remains derived, and the immediate goal is to make failure boundaries explicit and operationally safe.

## Goals / Non-Goals

**Goals:**
- Preserve restore activation success once restored SQLite state is active in the running process.
- Treat post-activation vector cleanup and rebuild failures as degraded reconciliation outcomes instead of full restore failure.
- Make successful reconciliation progress durable across partial failures.
- Ensure restore lifecycle and concurrency guards are always cleaned up safely.

**Non-Goals:**
- Changing the backup artifact format or introducing bundled Qdrant snapshots.
- Moving reconciliation to a background worker or defining a new large-restore async contract.
- Redesigning non-restore write-path synchronization or MCP transport behavior in this change.

## Decisions

1. Treat SQLite activation as the restore success boundary.
- Decision: once `reloadSqliteFromDisk()` succeeds, restore semantics treat metadata activation as complete even if later vector invalidation or reconciliation work degrades.
- Rationale: the running process has already crossed the authoritative SQLite recovery boundary, so reporting total restore failure is misleading and operationally unsafe.
- Alternative considered: keep returning full restore failure after post-activation vector errors. Rejected because it contradicts the activated runtime state and obscures the correct operator action.

2. Keep vector recovery explicit and best-effort after activation.
- Decision: failures in vector clearing or reconciliation after SQLite activation will leave restored rows unsynced and return explicit degraded readiness instead of negating activation.
- Rationale: Qdrant is derived state in this architecture, so vector recovery problems should degrade semantic readiness, not invalidate authoritative metadata activation.
- Alternative considered: trust pre-existing vectors when clear or rebuild fails. Rejected because it would reintroduce silent drift between restored metadata and vector state.

3. Persist reconciliation progress incrementally.
- Decision: successful vector rebuild progress will be flushed durably before returning from a partial reconciliation failure, so later retries resume from the remaining unsynced set.
- Rationale: it avoids repeating already completed rebuild work after restart and keeps sync markers aligned with actual Qdrant progress.
- Alternative considered: keep flushing only at the end of the batch. Rejected because it loses successful progress if a later upsert fails before the batch flush.

4. Collapse restore guard cleanup into a single fail-safe path.
- Decision: restore lifecycle acquisition and the in-progress flag will be arranged so every failure path releases concurrency state deterministically.
- Rationale: restore is a rare but high-impact operation, so sticky in-progress state is worse than a normal request failure.
- Alternative considered: leave the current ordering and rely on narrow trigger windows. Rejected because a single pre-try failure can block all later restores until restart.

## Risks / Trade-offs

- [Qdrant may still contain stale vectors when post-activation clear fails] -> Mitigation: keep vector reconciliation explicitly degraded/pending and never report full semantic readiness until recovery is complete.
- [Incremental flushes during reconciliation add overhead] -> Mitigation: flush per completed chunk or failure boundary rather than per unrelated operation.
- [Operators may interpret activated-but-degraded restore as full readiness] -> Mitigation: preserve clear restore result fields and health semantics that separate activation from reconciliation.

## Migration Plan

1. Refactor restore control flow so activation success is preserved once runtime SQLite reload completes.
2. Make post-activation vector clear and rebuild steps degrade restore readiness instead of failing the whole operation.
3. Persist successful reconciliation progress before returning pending status on partial failure.
4. Add regression tests for post-activation clear failure, partial rebuild durability, and restore guard cleanup.
5. Rollback strategy: revert to the prior restore implementation if needed; no backup format migration is involved.

## Open Questions

- Should a future follow-up move pending reconciliation to a background retry loop for large restores?
- Should restore emit additional audit or metrics events for “activated but degraded” outcomes beyond the existing health/reporting surfaces?
