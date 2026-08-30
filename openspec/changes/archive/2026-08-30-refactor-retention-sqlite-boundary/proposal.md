## Why

Retention logic currently reaches into a private SQLite store field via `as any`, coupling behavior to internal implementation details and weakening maintainability. This creates fragile code paths that can break silently during refactors.

## What Changes

- Introduce typed storage APIs needed by retention workflows instead of private field access.
- Refactor retention service to use public storage methods for stale-memory selection and marking.
- Add regression tests to ensure retention behavior remains correct after encapsulation.

## Capabilities

### New Capabilities
- `retention-storage-encapsulation`: Retention workflows use typed storage interfaces only.

### Modified Capabilities
- None.

## Impact

- Affected code: `src/backup/retention.ts`, `src/storage/sqlite.ts`, optionally `src/storage/index.ts`.
- Engineering quality: improved type safety, clearer module boundaries, and safer refactors.
