## Context

`RetentionService.markStaleMemories` executes raw SQL by accessing `(this.storage.sqlite as any).db`, bypassing the `SqliteStore` public API. This breaks encapsulation and type safety and creates hidden runtime coupling.

## Goals / Non-Goals

**Goals:**
- Remove `as any` access to private SQLite internals from retention service.
- Expose typed store methods for retention queries.
- Preserve existing stale-marking behavior.

**Non-Goals:**
- Reworking retention policy thresholds or consolidation logic.
- Introducing new database engines.

## Decisions

1. Add explicit store method(s) for stale candidate retrieval.
- Decision: expose typed methods such as `listStaleCandidateIds(cutoffIso)` in `SqliteStore`.
- Rationale: keeps SQL localized in storage layer and testable.
- Alternative considered: make private DB field public. Rejected due to poor encapsulation.

2. Keep retention orchestration in `RetentionService`.
- Rationale: service continues coordinating policy decisions while storage owns query details.
- Alternative considered: move full retention logic into storage layer. Rejected because it blends domain policy with persistence concerns.

## Risks / Trade-offs

- [Additional store methods increase API surface] -> Mitigation: keep methods narrowly scoped to retention use cases.
- [Behavior drift during refactor] -> Mitigation: add before/after regression tests for stale-marking counts.

## Migration Plan

- Add typed SQL store methods.
- Refactor retention service to call new methods.
- Remove `any` cast and private field access.
- Validate with retention unit tests.

## Open Questions

- Should retention methods be exposed via `StorageManager` facade or accessed on `SqliteStore` directly?
