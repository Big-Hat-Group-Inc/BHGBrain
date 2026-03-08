## Why

Backup restore currently reports success after writing the database file, but the running process continues using the in-memory `sql.js` state loaded at startup. This creates a false-success restore path and can re-overwrite restored bytes on the next flush.

## What Changes

- Define runtime-consistent restore semantics: a successful restore MUST make restored data active for subsequent reads/writes.
- Implement one of two explicit modes: in-process DB reinitialization on restore, or enforced restart-required restore that blocks normal operations until restart.
- Add integrity and state-transition checks so restore fails safely on invalid or partial restore conditions.
- Update restore response contract to include activation status and any required operator action.

## Capabilities

### New Capabilities
- `backup-restore-runtime-activation`: Ensure successful restore activates restored state for the running service.

### Modified Capabilities
- None.

## Impact

- Affected code: `src/backup/index.ts`, `src/storage/sqlite.ts`, `src/index.ts` (service lifecycle as needed).
- API behavior: `backup.restore` response and operational semantics become explicit.
- Reliability: Prevents false-positive restores and accidental data reversion after restore.
