## 1. Domain and Schema

- [x] 1.1 Add canonical retention tier types and lifecycle metadata definitions in `src/domain`.
- [x] 1.2 Extend SQLite memory schema with lifecycle columns and add migration coverage.
- [x] 1.3 Add `memory_revisions` and `memory_archive` tables with typed storage APIs.
- [x] 1.4 Add Qdrant payload/index support for `retention_tier`, `expires_at`, and `decay_eligible`.

## 2. Write and Read Paths

- [x] 2.1 Implement lifecycle policy service for tier assignment, expiry computation, promotion rules, and dedup thresholds.
- [x] 2.2 Integrate lifecycle assignment into the write decision pipeline.
- [x] 2.3 Route search, recall, resource reads, and injection flows through a shared retention-aware retrieval path.
- [x] 2.4 Persist access tracking and sliding-window expiry extension after successful reads.

## 3. Cleanup, Archive, and Admin

- [x] 3.1 Implement cleanup scanner, archive-before-delete flow, and final delete orchestration across SQLite and Qdrant.
- [x] 3.2 Implement T0 revision history persistence on update.
- [x] 3.3 Add CLI commands for `tier`, `archive`, `gc`, and tier-aware `stats`.
- [x] 3.4 Add restore/reconciliation behavior for archived or unsynced lifecycle records.

## 4. Health, Metrics, and Tests

- [x] 4.1 Add retention-specific health reporting for tier budgets, cleanup lag, and storage drift.
- [x] 4.2 Add structured audit events and metrics for promotion, archive, delete, restore, and compaction flows.
- [x] 4.3 Add unit tests for lifecycle policy logic and tier-specific dedup behavior.
- [x] 4.4 Add integration tests for SQLite/Qdrant partial-failure recovery, archive-before-delete, and retrieval-path expiry filtering.
- [x] 4.5 Add end-to-end CLI/MCP tests for tier management, cleanup dry-run, and tier-aware stats.

## Audit follow-ups (2026-06-05)

These items capture the genuinely missing or drifted work surfaced by the audit report `codeaudit/add-tiered-memory-lifecycle-2026-06-05-02-19.md`. Core lifecycle (domain model, schema, write/read paths, GC service, CLI, health tier counts) is already shipped; the gaps below are the operational tail and two correctness drifts.

- [x] 5.1 Wire the scheduled cleanup job: `embedding.cleanup_schedule` (cron, `src/config/index.ts:113`) is dead config read nowhere; add a scheduler that reads it and invokes `RetentionService.runGc` on the same execution surface as the CLI.
- [x] 5.2 Implement threshold-driven compaction: `compaction_deleted_threshold` (`src/config/index.ts:115`) is dead config; add a Qdrant compaction step gated on the deleted-vector ratio after GC.
- [x] 5.3 Emit cleanup metrics from `runGc` (`src/backup/retention.ts:54-66`): record duration, deleted count, archived count, and compaction activity via the existing `MetricsCollector` (`incCounter`/`recordHistogram`).
- [x] 5.4 Emit tier-transition audit events for promotion (`src/search/index.ts:252`), archival (`src/backup/retention.ts:56`), revision (`src/storage/index.ts:74`), delete, and restore, carrying `{memory_id, prior_tier, new_tier, actor, timestamp, action}` — today only generic `ADD`/`UPDATE`/`FORGET` codes are logged.
- [x] 5.5 Make GC failure-safe (`src/backup/retention.ts:54-66`): bracket the destructive phase with `beginLifecycleOperation`/`endLifecycleOperation` in a `finally`, wrap archive+delete in `try/catch`, and surface a degraded retention health signal on partial failure instead of throwing raw.
- [x] 5.6 DRIFT: filter expired memories from resource reads. `memory://{id}` (`src/resources/index.ts:61-67`) and `memory://list` (`src/resources/index.ts:73-92`) read SQLite directly with no expiry filtering, leaking expired decay-eligible `T2`/`T3` memories that search already excludes; route them through the shared retention-aware filter (call `lifecycle.isExpired` before returning) while keeping `T0`/`T1` eligible.
- [x] 5.7 DRIFT: gate `T1` deletion behind a warning/review window. `runGc` (`src/backup/retention.ts:29-33`) hard-deletes every decay-eligible non-`T0` row whose `expires_at < now`, including `T1`, ignoring `review_due`; exclude `T1` from direct delete and instead surface expired/`review_due`-past `T1` rows as review candidates, restricting direct deletion to `T2`/`T3`.
