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

## Risks / Trade-offs

- [Cross-store divergence] -> Mitigate with write orchestration and rollback/compensation on partial failures.
- [Over-aggressive UPDATE decisions] -> Mitigate with conservative threshold defaults and operation telemetry for tuning.
- [Namespace leakage through query defaults] -> Mitigate with mandatory namespace scoping in repository/service APIs.
- [Schema evolution pressure] -> Mitigate by versioned migrations and strict typed interfaces around persisted records.
