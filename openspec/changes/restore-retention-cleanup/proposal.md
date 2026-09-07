## Why

Retention cleanup currently acquires a lifecycle lock that rejects its own writes, leaving expiry, archival, audit pruning, and revision pruning inert while health can remain green. Once cleanup is restored, its selection, scheduling, history, and compaction paths also need bounds and truthful failure reporting so the subsystem remains safe at production scale.

## What Changes

- Permit the GC owner to perform its intended mutations while continuing to reject unrelated writes, and ensure degraded-state updates cannot be masked by the lifecycle guard.
- Allocate revision numbers from the maximum stored revision so pruning cannot freeze later T0 updates.
- Validate retention and distillation cron expressions at configuration load and expose scheduler failure state.
- Page expired candidates within a time/work budget, make archive writes idempotent, and retain enough progress information to resume safely.
- Treat Qdrant inspection failures as failures rather than fabricated empty collections, and log cleanup failures at actionable levels.

## Capabilities

### New Capabilities
- `retention-cleanup-safety`: Defines lifecycle ownership, bounded cleanup, idempotent archival, scheduler validation, revision pruning, compaction fidelity, and visible degraded outcomes.

### Modified Capabilities

## Impact

- Affected code: `src/backup/retention.ts`, `src/backup/scheduler.ts`, `src/storage/index.ts`, `src/storage/sqlite.ts`, `src/storage/qdrant.ts`, `src/health/index.ts`, configuration, and retention tests.
- Audit coverage: F3, F15, F16, F21, F23, F53, and F81 from `codeaudit/full-audit-2026-09-06-16-16.md`.
- Operational behavior: cleanup becomes functional, bounded, resumable, and health-visible.
