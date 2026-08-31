## 1. Storage queries

- [x] 1.1 `listReviewDue(namespace, before, limit, cursor)` on the SQLite store:
  non-archived memories with `review_due` ≤ the bound, oldest first, paginated.
- [x] 1.2 `searchArchived(namespace, query, limit)`: term match over
  `archived_memories` summary + tags (LIKE-based is acceptable; align with FTS5 for
  active memories if `upgrade-fulltext-to-fts5` has landed first).
  Note: `upgrade-fulltext-to-fts5` has not fully landed (11/14 tasks unchecked as of
  this pass), so the LIKE-based implementation stands per the task's own fallback.

## 2. The review tool

- [x] 2.1 Schema + handler: `action: list | keep | archive | restore`; `id` for the
  memory actions, `days` look-ahead and pagination for `list`.
- [x] 2.2 `keep`: re-extends `review_due` and `expires_at` per the tier's lifecycle
  policy (reusing `MemoryLifecycleService`), audited as a `REVISE`-family lifecycle
  event with `action: 'revise'` details noting a review confirmation.
- [x] 2.3 `archive`: routes through the existing archive path (vector delete + row
  archive), audited `ARCHIVE`; rejects already-archived ids with `CONFLICT`.
- [x] 2.4 `restore`: creates an active memory from an archive record (summary as
  content stub, tags, original tier), embeds it, links provenance in audit details,
  audited `RESTORE`; the archive row is retained.

## 3. Archived search

- [x] 3.1 `search` schema gains `include_archived` (default false); archived matches
  are appended with `archived: true`, are never access-recorded, and never count
  against the active-results limit reduction.

## 4. Tests

- [x] 4.1 `list` returns only due (or within `days`) non-archived memories, oldest
  first, paginated.
- [x] 4.2 `keep` extends review_due/expires_at per tier policy and audits.
- [x] 4.3 `archive` + `restore` round-trip: vector removed then re-created; audit
  entries present; double-archive → `CONFLICT`.
- [x] 4.4 `include_archived` surfaces an archived match by summary/tag term; default
  false excludes archives; no access recording on archived hits.

## 5. Docs (MCP surface change — full sync required)

- [x] 5.1 Update `CLAUDE.md` canonical tool list; README ×5 (§ MCP Tools Reference:
  `review` tool, `search.include_archived`); bump `package.json` version.
- [x] 5.2 `npm run lint` and `npm test` pass.
