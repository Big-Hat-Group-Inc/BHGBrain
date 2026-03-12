## 1. Domain and Schema

- [ ] 1.1 Add canonical retention tier types and lifecycle metadata definitions in `src/domain`.
- [ ] 1.2 Extend SQLite memory schema with lifecycle columns and add migration coverage.
- [ ] 1.3 Add `memory_revisions` and `memory_archive` tables with typed storage APIs.
- [ ] 1.4 Add Qdrant payload/index support for `retention_tier`, `expires_at`, and `decay_eligible`.

## 2. Write and Read Paths

- [ ] 2.1 Implement lifecycle policy service for tier assignment, expiry computation, promotion rules, and dedup thresholds.
- [ ] 2.2 Integrate lifecycle assignment into the write decision pipeline.
- [ ] 2.3 Route search, recall, resource reads, and injection flows through a shared retention-aware retrieval path.
- [ ] 2.4 Persist access tracking and sliding-window expiry extension after successful reads.

## 3. Cleanup, Archive, and Admin

- [ ] 3.1 Implement cleanup scanner, archive-before-delete flow, and final delete orchestration across SQLite and Qdrant.
- [ ] 3.2 Implement T0 revision history persistence on update.
- [ ] 3.3 Add CLI commands for `tier`, `archive`, `gc`, and tier-aware `stats`.
- [ ] 3.4 Add restore/reconciliation behavior for archived or unsynced lifecycle records.

## 4. Health, Metrics, and Tests

- [ ] 4.1 Add retention-specific health reporting for tier budgets, cleanup lag, and storage drift.
- [ ] 4.2 Add structured audit events and metrics for promotion, archive, delete, restore, and compaction flows.
- [ ] 4.3 Add unit tests for lifecycle policy logic and tier-specific dedup behavior.
- [ ] 4.4 Add integration tests for SQLite/Qdrant partial-failure recovery, archive-before-delete, and retrieval-path expiry filtering.
- [ ] 4.5 Add end-to-end CLI/MCP tests for tier management, cleanup dry-run, and tier-aware stats.
