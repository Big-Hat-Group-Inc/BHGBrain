## Context

`spec.md` defines v1 as a persistent memory server with strict namespace isolation and vector-backed recall. No prior OpenSpec capabilities exist in this repository, so this change creates the base contract that later MCP tool and operations capabilities will build on.

## Goals / Non-Goals

**Goals:**
- Define a normalized in-process memory model mapped to persisted SQLite/Qdrant records.
- Define write pipeline stages and decision rules for ADD/UPDATE/DELETE/NOOP.
- Guarantee namespace-scoped retrieval and dedup behavior by default.
- Define deterministic fallback behavior when model-assisted extraction/classification is unavailable.

**Non-Goals:**
- Full MCP transport/tool surface implementation.
- Backup/restore, audit log, and observability feature completion.
- Multi-user RBAC or encryption-at-rest.

## Decisions

1. Domain model first, transport second.
Rationale: All MCP tools share the same memory schema and write semantics; stabilizing this contract first prevents API churn.
Alternative considered: Implement tool handlers first and refine schema later. Rejected because it risks incompatible behavior across tools.

2. Dual-store persistence with SQLite as metadata authority and Qdrant as vector index.
Rationale: SQLite handles structured fields, FTS metadata, and deterministic updates; Qdrant handles semantic retrieval performance.
Alternative considered: Vector-only persistence. Rejected due to weak support for relational metadata and audit-oriented querying.

3. Decision pipeline returns explicit operation outcome per candidate.
Rationale: Returning ADD/UPDATE/DELETE/NOOP enables testable, auditable behavior and deterministic fallback parity.
Alternative considered: Hidden merge behavior with only final IDs returned. Rejected because it obscures data lifecycle.

4. Deterministic fallback threshold set as a hard requirement.
Rationale: v1 must function when extraction/classification models are unavailable; threshold-based dedup keeps behavior predictable.
Alternative considered: Fail all writes on model outage. Rejected because it violates graceful degradation goals.

5. Audit-driven decisions (2026-06-05).
The audit (`codeaudit/bootstrap-memory-core-2026-06-05-02-19.md`) surfaced spec-to-code
drift that this amendment resolves by tightening the contract:
   - **DELETE must be reachable or de-scoped.** Declaring and typing `DELETE` while the
     classifier can never produce it is treated as a defect; the spec now requires the
     operation be emitted (or removed from the contract).
   - **Fallback must threshold, not always ADD — the dedup-fallback duplication risk is
     the central concern.** Because the fallback path is entered precisely when
     embedding failed, it has no vector, and the current code unconditionally ADDs.
     Every near-duplicate written during a degraded window becomes a brand-new memory
     that the normal path would have merged, silently inflating storage and degrading
     recall quality. The amendment requires a vectorless similarity proxy (e.g.
     FTS/trigram) to restore UPDATE/ADD parity, or an explicit narrowing of the spec to
     checksum-only fallback. Either way, the divergence must be eliminated.
   - **Missing UPDATE target must be observable, never a silent duplicate.** A drifted
     store (Qdrant returns a target that SQLite no longer has) currently turns an
     intended UPDATE into a duplicate ADD with no signal — masking the very cross-store
     divergence listed as the top risk below. The amendment requires an error or an
     explicit warning log/metric.
   - **Degraded writes must be observable.** Entering the embedding-failure fallback
     must emit a structured log/metric so operators can see when recall quality is
     silently degraded.
Alternative considered: leave the code as-is and document the gaps only. Rejected —
the spec and implementation must agree, and the duplication risk is user-visible.

## Risks / Trade-offs

- [Cross-store divergence] -> Mitigate with write orchestration and rollback/compensation on partial failures.
- [Over-aggressive UPDATE decisions] -> Mitigate with conservative threshold defaults and operation telemetry for tuning.
- [Namespace leakage through query defaults] -> Mitigate with mandatory namespace scoping in repository/service APIs.
- [Schema evolution pressure] -> Mitigate by versioned migrations and strict typed interfaces around persisted records.
