# Tasks

## 1. Correct the restore response documentation

- [x] 1.1 Grep the README (and any other docs under the repo) for the restore response
  field `activated` to enumerate every occurrence:
  `grep -rn "activated" README.md` (expected: `README.md:1553,1631,1633,2309,2595`).
  **Premise no longer holds**: re-run against the current tree finds zero occurrences
  of a bare `activated` response field — every match is `metadata_activated` (or
  unrelated prose like "the restored database is activated"). The line numbers cited
  in the proposal (1553/1631/1633/2309/2595) don't correspond to the drift they
  describe anymore. See notes.
- [x] 1.2 Replace each documented `activated` reference with the actual emitted field
  `metadata_activated`, including the JSON example at `README.md:2309`
  (`{ "memory_count": 1234, "metadata_activated": true }`), the sequence diagram at
  `:1553`, and the prose at `:1631`, `:1633`, `:2595`.
  **Premise no longer holds**: there is nothing left to replace — `README.md` already
  uses `metadata_activated` at every one of those locations (now at lines
  1599/1639/1677/1679/2740 post-drift). No edit made; see notes.
- [x] 1.3 Document the `vector_reconciliation` field returned by `backup.restore`
  alongside `metadata_activated`, so the documented response schema matches the full
  `RestoreResult` shape (`src/domain/types.ts:110-114`).
  **Premise no longer holds**: `vector_reconciliation` is already documented in the
  JSON example (`README.md:2401-2408`), the sequence diagram (`:1599`), the numbered
  restore flow (`:1677`), and prose describing `state`/`readiness`
  (`reconciled`/`reconciling`, `:1683`, `:2409`). No edit made; see notes.
- [x] 1.4 Confirm the code field is NOT renamed — verify `metadata_activated` remains
  the emitted key in `src/domain/types.ts:112` and `src/backup/index.ts:124,132`
  (no source edits).

## 2. Verify no remaining drift

- [x] 2.1 Re-grep README/docs to confirm zero remaining references to a restore
  `activated` field and that `metadata_activated` and `vector_reconciliation` are both
  documented.

## 3. Validation

- [x] 3.1 Run `npm run lint`, `npm test`, and `npm run build`.
