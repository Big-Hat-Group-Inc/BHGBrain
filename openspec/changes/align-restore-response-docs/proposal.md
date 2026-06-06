# Align restore response documentation

## Why

The `fix-backup-restore-runtime-consistency` audit
(`codeaudit/fix-backup-restore-runtime-consistency-2026-06-05-02-19.md`, Finding 1,
Medium) found a documentation/contract drift: the README advertises a restore response
field named `activated` (e.g. `{ memory_count, activated: true }`), but the code never
emits that key. The actual `RestoreResult` (`src/domain/types.ts:112`) and the object
returned by `BackupService.restore` (`src/backup/index.ts:124,132`) expose
`metadata_activated`. An integrator coding against the documented `activated` field
reads `undefined` and may treat every restore as un-activated. README is the
user-facing contract per `CLAUDE.md` and must stay in sync with the code.

## What Changes

- Update the README so every reference to the restore response field `activated` is
  corrected to the actual emitted field name `metadata_activated`. Affected locations
  (from the audit / grep): `README.md:1553` (sequence diagram), `1631` (return prose),
  `1633` (restore-is-live prose), `2309` (JSON example), `2595` (runtime-activation
  prose).
- Document the `vector_reconciliation` field that restore also returns alongside
  `metadata_activated`, so the documented response schema is complete.
- Keep the emitted code field name `metadata_activated` unchanged (do NOT rename the
  code field), to avoid a breaking API change for existing consumers.
- Documentation-only change: no source behavior is modified.

## Capabilities

### New Capabilities

- `restore-response-doc-accuracy`: User-facing documentation of the `backup.restore`
  response SHALL accurately reflect the fields the code actually emits
  (`metadata_activated`, `vector_reconciliation`), with no references to non-existent
  fields such as `activated`.

### Modified Capabilities

(none)

## Impact

- Affected docs: `README.md` (restore response sections / examples).
- Affected code: none.
- Affected specs: adds `restore-response-doc-accuracy`.
- Risk: minimal — documentation correction only; aligns docs to the existing, shipped
  response contract.
