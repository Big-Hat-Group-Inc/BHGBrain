## Why

The degraded embedding fallback currently writes directly to SQLite and bypasses normal collection metadata and compatibility checks. That weakens recovery, repair, and cleanup flows for exactly the records created during degraded operation.

## What Changes

- Define degraded-write semantics that preserve collection metadata and embedding-space invariants even when vectors are unavailable.
- Require unsynced fallback writes to remain repairable by later reconciliation jobs.

## Capabilities

### New Capabilities
- `degraded-write-collection-metadata`: Degraded-mode writes preserve collection metadata and reconciliation safety.

### Modified Capabilities
- `degraded-embedding-and-health-semantics`: degraded mode gains stronger persistence guarantees.

## Impact

- Affected code: `src/pipeline/index.ts`, `src/storage/index.ts`, `src/storage/sqlite.ts`.
- Reliability: degraded-mode memories remain compatible with later vector sync and collection-level maintenance.
