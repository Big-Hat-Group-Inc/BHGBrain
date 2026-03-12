## Why

The current retention model only marks stale memories and explicitly avoids age-based hard deletion. That is too weak for the memory-management architecture now specified in `specmemorymanagement.md`, which requires tiered retention, archive-before-delete, version history for foundational knowledge, and capacity controls to keep Qdrant retrieval quality high over time.

Without a formal OpenSpec change, implementation would drift across storage, pipeline, search, health, and CLI modules without a coherent contract.

## What Changes

- Add a tiered memory lifecycle capability with `T0` through `T3` retention semantics.
- Define lifecycle metadata, tier assignment rules, access-driven promotion, archive-before-delete, and T0 revision history.
- Define shared retrieval-path behavior for expiry filtering, access tracking, and tier-aware ranking hints.
- Add operational requirements for cleanup jobs, capacity budgets, and storage-drift health reporting.
- Modify the existing retention capability to replace stale-only behavior with tier-based archive/delete behavior for eligible memories.

## Capabilities

### New Capabilities
- `tiered-memory-lifecycle`: retention tiers, expiry rules, promotions, archival, revision history, cleanup execution, and admin controls.

### Modified Capabilities
- `retention-and-degradation`: replace stale-only retention with tier-based lifecycle enforcement while preserving deterministic degraded behavior.
- `observability-health`: add retention-specific metrics and health signals for storage drift, tier budgets, and cleanup execution.

## Impact

- Affected code: `src/domain`, `src/pipeline`, `src/storage`, `src/search`, `src/health`, `src/cli`, `src/tools`, and `src/resources`.
- Requires SQLite schema changes, new Qdrant payload indexes, and lifecycle job orchestration.
- Requires integration coverage for cross-store consistency, archive/delete recovery, and tier-aware read/write behavior.
