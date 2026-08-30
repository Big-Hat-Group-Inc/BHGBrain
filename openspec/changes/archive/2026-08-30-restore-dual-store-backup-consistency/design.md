## Context

BHGBrain treats SQLite as the system of record and Qdrant as the vector search index, but restore currently only replaces and reactivates SQLite. That means the running process can have restored metadata while Qdrant still reflects a newer or unrelated state. Because semantic search and similarity dedup depend on Qdrant, restore needs a clear dual-store story instead of assuming vector state is implicitly valid.

## Goals / Non-Goals

**Goals:**
- Make restore semantics explicit for both SQLite metadata and Qdrant vector state.
- Preserve SQLite-first recovery while preventing silent post-restore vector drift.
- Surface restore readiness and post-restore reconciliation state to operators and health checks.
- Define a path that works even if the backup artifact itself remains SQLite-only.

**Non-Goals:**
- Introducing a new external backup dependency or bundling vendor-specific Qdrant snapshot formats into this change.
- Redesigning normal write-path synchronization rules outside restore and reconciliation flows.
- Guaranteeing instant semantic readiness for very large restores.

## Decisions

1. Keep SQLite as the restore source of truth.
- Decision: restore will continue to activate restored SQLite state first, and post-restore vector state will be derived from that restored metadata set.
- Rationale: SQLite already owns durable metadata, auditability, and restore activation semantics in this codebase.
- Alternative considered: make restore depend on a bundled Qdrant snapshot. Rejected because it would tightly couple backups to backend-specific artifacts and deployment details.

2. Treat restore as a reconciliation boundary for vectors.
- Decision: after restore, the system SHALL explicitly mark vector readiness as reconciled, reconciling, or pending instead of assuming Qdrant is valid.
- Rationale: it prevents false-success restores where semantic features quietly operate on drifted data.
- Alternative considered: leave existing vector state untouched and rely on health warnings only. Rejected because it still leaves semantic behavior undefined.

3. Rebuild or re-sync vectors from restored SQLite content.
- Decision: the design target is a reconciliation flow that re-upserts vectors from restored SQLite rows and updates sync markers as it completes.
- Rationale: it keeps one authoritative recovery source and reuses existing embedding + Qdrant write primitives.
- Alternative considered: clear all vectors and require manual external rebuild tooling. Rejected because it adds operator burden without a defined product contract.

4. Restore success must distinguish metadata activation from semantic readiness.
- Decision: restore responses and health reporting will separate “SQLite activated” from “vector state fully ready.”
- Rationale: operators need to know whether the service is merely restored or fully ready for semantic features.
- Alternative considered: one boolean success flag. Rejected because it hides the exact state that needs operator attention.

## Risks / Trade-offs

- [Vector reconciliation can be expensive for large restores] -> Mitigation: allow batched reconciliation and explicit degraded health while batches run.
- [Reconciliation depends on embedding availability] -> Mitigation: preserve restored SQLite state even when embeddings are unavailable and report pending vector recovery explicitly.
- [Temporary degraded semantic behavior after restore can surprise clients] -> Mitigation: expose readiness in restore responses and health snapshots so the degraded window is explicit and testable.

## Migration Plan

1. Extend restore workflow to mark or compute post-restore vector reconciliation state.
2. Add reconciliation helpers that can rebuild vectors from restored SQLite rows.
3. Update restore response and health reporting to surface metadata activation and vector readiness separately.
4. Add tests for restore with stale Qdrant state, missing embeddings, and successful reconciliation.

## Open Questions

- Should reconciliation run inline for small restores and switch to batched/background execution only past a size threshold, or should all restores use the same asynchronous readiness contract?
