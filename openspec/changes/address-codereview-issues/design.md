## Context

`codereview.md` (2026-03-07) highlights systemic risks across persistence, consistency, transport security, MCP interoperability, and observability. Several earlier findings are already fixed, but new requirements are needed to formalize the remaining gaps and prevent regressions.

## Goals / Non-Goals

**Goals:**
- Convert review findings into testable OpenSpec requirements.
- Prioritize contracts that reduce data inconsistency, durability ambiguity, and security misconfiguration risk.
- Align MCP behavior with agent-friendly structured contracts.

**Non-Goals:**
- Full storage engine migration in this single change.
- Redesigning every endpoint or protocol surface beyond findings scope.
- Defining product-level UX behavior outside server contracts.

## Decisions

1. Use one consolidated change with capability-partitioned specs.
- Rationale: Findings are cross-cutting, but implementation can still be staged by capability.
- Alternative considered: one change per finding. Rejected to reduce coordination overhead and duplicated context.

2. Model requirements around externally observable behavior.
- Rationale: behavior-centric specs survive internal refactors and are easier to validate.

3. Prioritize fail-safe semantics over silent degradation.
- Rationale: codereview findings repeatedly show hidden failures (silent empty results, non-durable ack, fail-open auth).

4. Require compatibility-preserving migrations where possible.
- Rationale: some fixes alter runtime contracts (auth defaults, MCP response shape); rollout must remain controlled.

## Risks / Trade-offs

- [Broad scope could slow implementation] -> Mitigation: execute by capability in priority order with separate task groups.
- [Stricter contracts may break permissive clients] -> Mitigation: support transitional compatibility fields and explicit docs.
- [Performance fixes may alter freshness semantics] -> Mitigation: define bounded async update windows and observability metrics.

## Migration Plan

- Phase 1: persistence efficiency + durability + consistency primitives.
- Phase 2: auth hardening + MCP structured response contracts.
- Phase 3: degraded embedding/health + search/resource correctness + observability/storage safety.
- After each phase: run compatibility checks and update docs/tests.

## Open Questions

- Whether to keep custom HTTP tool/resource surface alongside MCP stdio long-term.
- Whether to introduce feature flags for strict auth and structured MCP outputs during transition.
- Whether `sql.js` can meet target SLOs without engine migration.
