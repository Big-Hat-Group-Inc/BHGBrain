## Context

The current write pipeline computes a dedup decision (`ADD`/`UPDATE`/`NOOP`) but only implements `UPDATE` and `ADD` branches, causing `NOOP` to fall through into `ADD`. Collection deletion currently deletes only metadata from `collections`, leaving SQLite memories and Qdrant vectors behind. Both issues cross storage and tool boundaries and require explicit behavioral contracts.

## Goals / Non-Goals

**Goals:**
- Make `NOOP` classification terminal, with no storage mutation.
- Define deterministic collection deletion semantics that preserve cross-store consistency.
- Ensure error handling, audit behavior, and operator-facing responses match the new contracts.

**Non-Goals:**
- Reworking dedup scoring/threshold algorithms.
- Introducing soft-delete or archival workflows for collections.
- Redesigning Qdrant naming conventions or namespace model.

## Decisions

1. Implement explicit `NOOP` branch in `WritePipeline.decide`.
- Rationale: The decision layer already owns dedup outcome; terminal handling here avoids accidental writes and keeps behavior local.
- Alternative considered: enforce in `StorageManager.writeMemory` by rejecting near-duplicate writes. Rejected because write path lacks decision context and would duplicate classification responsibilities.

2. Standardize collection deletion as a guarded cascade.
- Decision: `collections.delete` will perform one of two outcomes:
  - fail with `CONFLICT` when collection is non-empty and `force` is not set;
  - when forced, delete SQLite memories for `(namespace, collection)`, delete Qdrant collection, then delete collection metadata.
- Rationale: Prevents silent data loss while ensuring forced deletion leaves no orphaned data.
- Alternative considered: always hard-delete by default. Rejected due to higher accidental data-loss risk.

3. Add store-level helpers for collection-scoped operations.
- Rationale: Keeps deletion logic cohesive and testable (`count/delete memories by collection`, `delete collection vectors`), avoiding tool-layer SQL assembly.
- Alternative considered: execute raw SQL directly in tool handler. Rejected due to layering violations and weaker testability.

## Risks / Trade-offs

- [Forced delete can remove large datasets] -> Mitigation: return deleted counts and log audit entries for bulk deletes.
- [Cross-store partial failure during cascade] -> Mitigation: apply ordered deletion and fail safely with clear error; prefer metadata deletion last.
- [API contract change for `collections.delete`] -> Mitigation: document force semantics and provide backward-compatible default (safe reject for non-empty).

## Migration Plan

- Ship with `force` optional and default `false`.
- Existing clients calling delete on empty collections continue to work unchanged.
- Update docs/examples for non-empty delete behavior and force usage.
- Rollback: revert handler behavior to metadata-only delete (not recommended except emergency).

## Open Questions

- Should forced collection delete emit one aggregate audit event or per-memory events?
- Should collection delete support dry-run to return impacted counts before force delete?
