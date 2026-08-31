## 1. Storage layer

- [x] 1.1 Extract the query normalization `query.toLowerCase().split(/\s+/).filter(Boolean)`
  from `fullTextSearch` (`src/storage/sqlite.ts:1201`) into a private static helper
  `SqliteStore.splitQueryTerms(query: string): string[]`, and call it from
  `fullTextSearch` — no behavior change on the active-search path.
- [x] 1.2 Rewrite `searchArchived` (`src/storage/sqlite.ts:1838-1845`) to call
  `splitQueryTerms`, return `[]` when it yields no terms, and otherwise build one
  `(LOWER(summary) LIKE ? OR LOWER(tags) LIKE ?)` conjunct per term joined with
  `AND` (params pushed per term, mirroring `fullTextSearchLike`'s loop shape at
  `:1299-1302`), keeping `namespace = ?` first and `ORDER BY expired_at DESC LIMIT ?`
  unchanged.
- [x] 1.3 Update the doc comment on `searchArchived` (and the interface entry at
  `src/storage/sqlite.ts:143` if it carries one) to state the per-term AND contract
  and the empty-query behavior.
- [x] 1.4 (Added during implementation) Give the namespace-agnostic CLI sibling
  `searchArchive` the same per-term semantics by having both methods delegate to one
  private `searchArchiveByTerms(namespace | null, query, limit)` core — see design.md.

## 2. Tests (`src/storage/sqlite.test.ts`)

- [x] 2.1 Multi-word, non-contiguous match: archive a memory with summary
  "deployment note for the functional test"; assert `searchArchived('global',
  'deployment functional test', 10)` returns it (fails against the old
  whole-substring implementation).
- [x] 2.2 Terms split across columns: archive a memory with summary
  "a note about kubernetes" and tags `['ops']`; assert query `"kubernetes ops"`
  matches it (one term satisfied by summary, the other by tags).
- [x] 2.3 AND semantics: with the same fixtures, assert a query containing one
  matching and one absent term (e.g. `"kubernetes zeppelin"`) returns `[]`.
- [x] 2.4 Empty and whitespace-only queries return `[]` — and specifically do NOT
  return every archived row (regression test for the `LIKE '%%'` edge).
- [x] 2.5 Superset/back-compat (plus a 2.5b test covering `searchArchive`'s CLI path:
  cross-namespace multi-word matching and the empty-query edge): a single-term query and a query that IS a contiguous
  summary substring (e.g. `"functional test"`) both still match as before.
- [x] 2.6 Confirm the existing test at `src/storage/sqlite.test.ts:1020`
  ("searchArchived matches retained summary/tags and scopes to the given namespace")
  passes unmodified — single-term matching and namespace scoping are unchanged.
- [x] 2.7 Active-path regression: existing `fullTextSearch` tests pass unmodified
  after the 1.1 helper extraction.

## 3. Docs and validation

- [x] 3.1 `README.md`: update the archive-section paragraph (`:1779-1784`) and the
  `search` tool's `include_archived` parameter row (`:3135`) and output note
  (`:3139`) to say matching requires every whitespace-separated query term to hit
  the retained summary or tags (case-insensitive substring per term).
- [x] 3.2 Mirror the same edits into `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md` — all five or none, per CLAUDE.md.
- [x] 3.3 Bump `package.json` via `npm version patch` (currently `1.34.3`; never
  hand-edit — keeps `package-lock.json` in sync). → `1.34.4`.
- [x] 3.4 Run `npm run lint && npm test`; fix any fallout before declaring the change
  complete. → lint clean; 1044/1044 tests pass (48 files).
