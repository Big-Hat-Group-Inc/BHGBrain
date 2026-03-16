## Context

BHGBrain is a dual-store memory system: SQLite is the durable metadata store and Qdrant is the semantic retrieval index. The new memory management specification requires tier-based lifecycle behavior that cuts across ingestion, retrieval, cleanup, CLI administration, and health reporting. The design must preserve cross-store consistency and avoid scattering lifecycle rules across tool handlers.

## Goals / Non-Goals

**Goals:**
- Introduce a canonical lifecycle model with `T0`, `T1`, `T2`, and `T3`.
- Centralize retention decisions in a domain service rather than embedding them in tools or transport handlers.
- Treat SQLite as the retention system of record and Qdrant as a synchronized search index.
- Support archive-before-delete, T0 revision history, tier-aware retrieval, and capacity governance.

**Non-Goals:**
- Replacing Qdrant or SQLite with different storage engines.
- Reworking unrelated MCP contracts beyond retention-aware fields and commands.
- Designing a generic job scheduler beyond the lifecycle jobs needed by this change.

## Decisions

1. Introduce a dedicated lifecycle policy service.
- Decision: add a service in `src/domain` such as `MemoryLifecycleService` to own tier assignment, expiry calculation, promotion thresholds, dedup thresholds, and expiring-soon logic.
- Rationale: prevents duplicated policy logic across pipeline, search, and cleanup flows.
- Alternative considered: keep rules inline in each module. Rejected due to drift risk.

2. Use SQLite as the source of truth for lifecycle state.
- Decision: persist lifecycle metadata and archive/revision state in SQLite first, then synchronize Qdrant payloads.
- Rationale: SQLite already stores durable metadata and supports recovery, audit, and replay.
- Alternative considered: derive lifecycle state primarily from Qdrant payloads. Rejected because it weakens recovery semantics.

3. Route all reads through one retention-aware retrieval path.
- Decision: shared query service applies namespace scoping, expiry filtering, tier hints, and access tracking consistently for MCP tools, resources, and CLI.
- Rationale: avoids divergent expiry behavior and duplicate access-counter mutations.

4. Implement cleanup as an internal service invoked by scheduler and CLI.
- Decision: `bhgbrain gc` and the scheduled cleanup job both call the same retention execution service.
- Rationale: one implementation surface is easier to test and makes dry-run behavior trustworthy.

5. Replace stale-only retention semantics with tiered lifecycle semantics.
- Decision: prior stale marking behavior becomes one internal signal, not the terminal behavior. Eligible `T2` and `T3` memories may be archived and deleted once expiry policy is met.
- Rationale: this is required by the new specification and is the only way to maintain vector hygiene over time.

## Risks / Trade-offs

- [Cross-store drift during partial failures] -> Mitigation: add `vector_synced` or equivalent reconciliation metadata and expose drift in health.
- [Over-aggressive classification can delete useful memories] -> Mitigation: default unknown content to `T2`, require stronger signals for `T0`, and support pre-expiry warnings plus manual promotion.
- [Cleanup jobs can create operational load] -> Mitigation: batch deletes, support dry-run, and compact only after thresholds are met.
- [Spec overlap with existing retention capability] -> Mitigation: explicitly modify `retention-and-degradation` in the same change set.

## Architecture

### Domain

- Add lifecycle enums/types for retention tiers and lifecycle metadata.
- Add policy functions for assignment, expiry, promotion, and deletion eligibility.

### Pipeline

- Write pipeline assigns `retention_tier`, `expires_at`, `decay_eligible`, and `review_due`.
- Tier-specific dedup thresholds apply before write decisions are committed.

### Storage

- Extend SQLite memory schema with lifecycle columns.
- Add `memory_revisions` and `memory_archive` tables.
- Add typed storage methods for:
  - updating access counters
  - listing expired candidates
  - archiving deletion summaries
  - storing T0 revisions
  - reconciling unsynced vector state

### Search and Retrieval

- Retrieval excludes expired `T2`/`T3` by default.
- Retrieval always keeps `T0`/`T1` candidates eligible for ranking.
- Successful retrieval updates access state and can extend sliding expiry windows.

### Cleanup Execution

- Scanner selects eligible rows from SQLite.
- Archive writer persists deletion summaries before destructive actions.
- Vector delete executes before final metadata removal.
- Compaction is threshold-driven, not per-delete.

### Health and Observability

- Health reports tier counts, budget pressure, cleanup lag, and SQLite/Qdrant lifecycle drift.
- Metrics and structured audit events capture promotions, archival, deletion, restore, and revision activity.

## Migration Plan

1. Add lifecycle schema fields and storage methods behind write-path support only.
2. Enable read-path filtering and access tracking.
3. Add archive/revision persistence and dry-run cleanup.
4. Enable actual `T3` deletion first, then `T2` lifecycle enforcement.
5. Enable budget-based pruning and compaction signals.

## Open Questions

- Should `T1` review workflows be surfaced only via CLI initially, or also through MCP resources in the same change?
- Should expired memories be soft-deleted for one release window before permanent deletion, or is archive-only recovery sufficient?
