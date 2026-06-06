# Design

## Context

The completed `fix-backup-restore-runtime-consistency` change made `backup.restore`
reload runtime SQLite state and return an activation indicator. Its audit
(`codeaudit/fix-backup-restore-runtime-consistency-2026-06-05-02-19.md`) confirmed the
behavior is implemented and well-tested, but flagged one Medium maintainability finding:
the README documents a restore response field `activated` that the code does not emit.

The code's real contract is defined by `RestoreResult` in `src/domain/types.ts:110-114`,
which carries `memory_count`, `metadata_activated`, and `vector_reconciliation`. The
returned object at `src/backup/index.ts:124,132` sets `metadata_activated: true`. There
is no `activated` key anywhere in the code path. The README, however, names the field
`activated` in five places (`README.md:1553,1631,1633,2309,2595`). Because `CLAUDE.md`
designates README as the user-facing contract, this drift is a real integrator-facing
defect even though the spec requirement (an explicit activation indicator) is met.

## Goals / Non-Goals

Goals:
- Make the README restore response documentation accurately describe the fields the code
  emits: `metadata_activated` and `vector_reconciliation`.
- Remove all references to the non-existent `activated` field.

Non-Goals:
- Changing any runtime behavior of `backup.restore`.
- Renaming the emitted code field `metadata_activated`.
- Addressing the audit's other (non-doc) findings (vector-wipe window, finally-block
  masking, reload ordering, operator remediation text). Those are out of scope here.

## Decisions

1. **Align the docs to the code, not the code to the docs.** Correct the README to use
   `metadata_activated` rather than renaming the emitted field to `activated`. Renaming
   the code field would be a breaking change to the `backup.restore` response contract
   for any existing consumer already reading `metadata_activated`; the documentation is
   the side that is wrong, and it is the cheaper and lower-risk fix.
2. **Document `vector_reconciliation` too.** The audit notes the response also returns
   `vector_reconciliation` (with a `readiness` of `ready`/`degraded`/`pending`), which
   the README does not document. Including it makes the documented schema match the full
   `RestoreResult` so a future reader is not surprised by an undocumented field.
3. **Documentation-only scope.** No source files are edited. The change touches README
   (and any other docs that reference the field) only.

### Rejected alternative

- **Rename the code field `metadata_activated` → `activated` (or add an `activated`
  alias).** Rejected. Renaming is a breaking API change to a shipped response contract;
  adding an alias permanently widens the response surface and duplicates a single boolean
  for no functional benefit. The documentation is the incorrect artifact, so correcting
  the documentation is the right and least-risk fix.

## Risks / Trade-offs

- Risk: another doc surface (e.g. an external integration guide) might still reference
  `activated`. Mitigation: task 1.1/2.1 grep the repo, not just the known line numbers.
- Trade-off: integrators who (incorrectly) coded against the documented `activated`
  field were already broken against the real response; this change does not regress them
  and points them at the correct field.

## Migration Plan

No migration required. Documentation-only change; the response schema is unchanged, so
no consumer behavior changes. Ship as a normal docs update (bump `package.json`
`version` if treated as a user-visible doc fix, per `CLAUDE.md`).

## Open Questions

- Should the README also note the `vector_reconciliation.readiness` value set
  (`ready` / `degraded` / `pending`) in the response schema, or just name the field?
  (Leaning toward naming the field plus its readiness values for completeness.)
