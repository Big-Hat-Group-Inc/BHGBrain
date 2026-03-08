## Context

`BackupService.restore` verifies checksum and writes backup payload to `brain.db`, but `SqliteStore` uses an in-memory `sql.js` database object that is not reloaded after file replacement. Runtime reads/writes continue from stale state until restart, and subsequent flushes may overwrite restored data.

## Goals / Non-Goals

**Goals:**
- Guarantee that a successful restore has deterministic runtime effect.
- Prevent stale in-memory state from diverging from restored on-disk state.
- Preserve backup integrity validation and clear operator feedback.

**Non-Goals:**
- Changing backup file format version in this change.
- Cross-node distributed restore orchestration.
- Point-in-time recovery beyond full DB restore.

## Decisions

1. Adopt active-reload restore flow.
- Decision: After checksum verification and file write, close current SQLite handle and reinitialize `SqliteStore` from restored bytes before returning success.
- Rationale: Aligns observable runtime behavior with API success semantics.
- Alternative considered: require restart and return `restart_required`. Rejected as default due to poorer UX and higher ops burden, but can remain as fallback if reload fails.

2. Add explicit restore state result contract.
- Decision: `restore` response includes `memory_count` and `activated: true|false` (or equivalent status) with actionable message on degraded fallback.
- Rationale: Operators need unambiguous post-restore state.
- Alternative considered: keep existing minimalist response. Rejected because it hides activation risk.

3. Protect against partial state during restore.
- Decision: keep validation-before-write and wrap reload in guarded error flow; if reload fails, return error and avoid silent success.
- Rationale: Fail fast is safer than running with unknown state.

## Risks / Trade-offs

- [Reload sequence may interrupt in-flight operations] -> Mitigation: serialize restore operation and reject concurrent mutating operations while restore is running.
- [Reload code increases lifecycle complexity] -> Mitigation: encapsulate reload behavior in storage service with tests.
- [Backward compatibility on response shape] -> Mitigation: preserve existing fields and add non-breaking optional fields.

## Migration Plan

- Implement reload-capable restore in backup/storage services.
- Add integration tests for restore-before/after read consistency.
- Deploy with logging for restore activation outcome.
- Rollback: disable active reload and return explicit restart-required error.

## Open Questions

- Should restore also refresh dependent derived state (metrics caches, long-lived resource handlers) explicitly?
- Should restore lock the tool endpoint globally during the operation?
