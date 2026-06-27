# Tasks

## 1. Correct the restore response documentation

- [ ] 1.1 Grep the README (and any other docs under the repo) for the restore response
  field `activated` to enumerate every occurrence:
  `grep -rn "activated" README.md` (expected: `README.md:1553,1631,1633,2309,2595`).
- [ ] 1.2 Replace each documented `activated` reference with the actual emitted field
  `metadata_activated`, including the JSON example at `README.md:2309`
  (`{ "memory_count": 1234, "metadata_activated": true }`), the sequence diagram at
  `:1553`, and the prose at `:1631`, `:1633`, `:2595`.
- [ ] 1.3 Document the `vector_reconciliation` field returned by `backup.restore`
  alongside `metadata_activated`, so the documented response schema matches the full
  `RestoreResult` shape (`src/domain/types.ts:110-114`).
- [ ] 1.4 Confirm the code field is NOT renamed — verify `metadata_activated` remains
  the emitted key in `src/domain/types.ts:112` and `src/backup/index.ts:124,132`
  (no source edits).

## 2. Verify no remaining drift

- [ ] 2.1 Re-grep README/docs to confirm zero remaining references to a restore
  `activated` field and that `metadata_activated` and `vector_reconciliation` are both
  documented.

## 3. Validation

- [ ] 3.1 Run `npm run lint`, `npm test`, and `npm run build`.
