## Context

The primary TypeScript configuration excludes tests, ESLint lacks type information, coverage has no command or threshold, and lifecycle tests mock away the store guard they need to verify. Recovery mappings and complex handlers are also duplicated. See `proposal.md` and `specs/verification-and-maintainability-guardrails/spec.md`.

## Goals / Non-Goals

**Goals:**
- Make the standard verification workflow catch promise and test-contract failures.
- Exercise real lifecycle/storage composition at critical seams.
- Consolidate duplicated boundary mappings into independently testable functions.

**Non-Goals:**
- Pursuing 100 percent coverage.
- Rewriting all modules solely to satisfy a style metric.
- Changing product behavior beyond the audit remediation specs.

## Decisions

1. Add a test-aware TypeScript project and typed ESLint project service.
- `lint` will type-check production and tests and enable floating/misused-promise rules. Initial violations will be fixed or explicitly handled, never blanket-disabled.
- Continuing esbuild-only test transpilation was rejected because it cannot validate mocks or async contracts.

2. Establish coverage thresholds from a measured baseline.
- A committed coverage command records statement, branch, function, and line thresholds rounded down modestly from the current run; future changes may only raise them.
- Picking aspirational thresholds before measurement was rejected because it would create unrelated remediation churn.

3. Use real SQLite for lifecycle integration tests and narrow fake providers for external boundaries.
- GC and restore tests will exercise lifecycle locks, migrations, transactions, and health state together while using deterministic Qdrant/embedding doubles.
- Fully mocked storage was rejected because it let the self-rejecting GC pass.

4. Make tool/transport name parity a generated-set invariant.
- Tests compare dispatch cases, schema registrations, MCP declarations, and REST validation in both directions.
- A one-direction check was rejected because hidden dispatch-only tools still escape it.

5. Place canonical payload mapping beside storage domain conversion.
- One pure, schema-narrowing function converts Qdrant payloads to recoverable memory fields; hydration, repair, and fallback consume it.
- Three hand-maintained object literals were rejected because new lifecycle fields are missed during disaster recovery.

6. Extract behavior seams from large handlers incrementally.
- Pure pool sizing, fusion, mapping, and per-action handlers move first, retaining the public dispatcher and types. Refactors follow behavior fixes where ordering matters.
- A whole-file rewrite was rejected due to review and regression risk.

## Risks / Trade-offs

- [Type-aware lint exposes a large backlog] -> Land configuration with scoped fixes in small commits and no broad rule suppression.
- [Real-store tests run slower] -> Keep a small number of seam-focused cases and reuse temporary-store helpers.
- [Refactor overlaps other proposals] -> Apply shared mapper/extractions after the corresponding behavior tests exist and coordinate task dependencies.

## Migration Plan

1. Measure coverage and add test TypeScript/lint configuration.
2. Add real-store retention and transport/dispatch contract tests before high-risk fixes.
3. Add the canonical payload mapper and migrate consumers.
4. Extract pure handler/search helpers after their behavior changes land.
5. Ratchet coverage thresholds as each proposal adds regression tests.
