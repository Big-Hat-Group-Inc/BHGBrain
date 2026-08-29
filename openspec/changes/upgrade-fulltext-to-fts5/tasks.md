## 1. FTS5 table and probe

- [x] 1.1 Add a startup FTS5 capability probe (attempt `CREATE VIRTUAL TABLE ... USING
  fts5` in a temp schema); record the result on the store instance.
  > Implemented: `SqliteStore.probeFts5Support()` (`src/storage/sqlite.ts`), run in
  > both `init()` and `reloadFromDisk()`, result cached on `ftsAvailable` and exposed
  > via `isFts5Available()`. `migrate-sqlite-to-native-engine` switched the engine to
  > `node:sqlite`'s `DatabaseSync`, whose bundled SQLite build compiles fts5 in, so
  > the probe now correctly returns `true` (pinned by a canary test in
  > `src/storage/sqlite.test.ts`) — it stays a real, engine-agnostic probe rather than
  > an assumption, so it would correctly flip back to `false` on a build that lacks
  > the module.
- [x] 1.2 Define the FTS5 virtual table (`tokenize='porter unicode61'`) with content,
  summary, tags as searchable columns and namespace/collection as UNINDEXED filter
  columns; document that it is derived data rebuildable from `memories`.
  > Implemented: `memories_fts` is now, when `ftsAvailable`, an FTS5 virtual table
  > (`id`/`namespace`/`collection` UNINDEXED, `content`/`summary`/`tags` indexed,
  > `tokenize = 'porter unicode61'`), created/maintained by `ensureFtsSchema()` /
  > `migrateToFts5()` in `src/storage/sqlite.ts`. `SCHEMA_SQL` no longer creates a
  > plain `memories_fts` table — a comment there documents that the table is derived
  > data whose shape is chosen at runtime by `ensureFtsSchema()`.

## 2. Migration and write-path maintenance

- [x] 2.1 Idempotent startup migration: detect the legacy plain `memories_fts` table,
  create the FTS5 table, batch-backfill from `memories`, and swap; safe to re-run and
  safe to interrupt (rebuild from source of truth).
  > Implemented: `ensureFtsSchema()` (called from `openDatabase()`, right after the
  > FTS5 probe) detects the on-disk `memories_fts` shape via `sqlite_master.sql`
  > (`CREATE VIRTUAL TABLE` vs. plain `CREATE TABLE`). When FTS5 is available and the
  > table isn't already FTS5, `migrateToFts5()` builds a scratch
  > `memories_fts5_migrating` FTS5 table, backfills it from `memories` (the source of
  > truth, not the stale legacy FTS rows) via `backfillFtsFromMemories()` — 500-row
  > JS-side batches, keyset-paginated by id — then drops the old `memories_fts` and
  > renames the scratch table onto it, all inside one `BEGIN/COMMIT` transaction so a
  > crash mid-migration rolls back to the pre-migration state (verified empirically:
  > FTS5 shadow-table DDL and `ALTER TABLE ... RENAME` both participate correctly in
  > an explicit transaction/rollback under `node:sqlite`). Re-running is a no-op once
  > `memories_fts` is already FTS5. Covered by
  > `src/storage/sqlite.test.ts`'s "migrates a legacy plain-table memories_fts to
  > FTS5 on reopen" test (seeds a legacy table with deliberately wrong data, reopens
  > twice, asserts the table is FTS5 and results come from `memories` not the stale
  > row).
- [x] 2.2 Maintain the FTS index on every memory insert/update/delete/archive path in
  `src/storage/sqlite.ts` (including restore/repair bulk paths).
  > The legacy `memories_fts` write-through hooks (`insertMemory`,
  > `upsertMemoryFromPayload`, `updateMemory`'s content/summary/tags/archived branch,
  > `deleteMemory`, `deleteMemoriesInCollection`) already write through to whatever
  > `memories_fts` currently is — no new write orchestration was needed (per
  > design.md). They were updated to also populate the now-required `collection`
  > column (added to both the FTS5 and legacy-plain table shapes so the filter can
  > run directly against `memories_fts.collection` without a join). Restore/repair
  > paths that rehydrate via `upsertMemoryFromPayload` inherit this for free.

## 3. Query path

- [x] 3.1 Reimplement `fullTextSearch` on FTS5 MATCH + `bm25()` with column weights
  preserving the summary/tags > content intent; escape/sanitize user query into FTS5
  MATCH syntax safely (no raw query-string injection into MATCH).
  > Implemented: `fullTextSearchFts5()` queries `memories_fts MATCH ?` and ranks with
  > `bm25(memories_fts, 1.0, 2.0, 2.0)` (content/summary/tags weights, mirroring the
  > legacy 1x/2x/2x intent), verified directly against `node:sqlite` to confirm
  > column-weight and length-normalization behavior before relying on it in tests.
  > `buildFts5MatchExpression()` sanitizes: terms are lowercased/whitespace-split (as
  > before), each wrapped as a double-quoted literal phrase (embedded `"` doubled
  > per SQL escaping) and joined with explicit `AND`, so FTS5 operator syntax in a
  > term can never be parsed as an operator — verified against `NEAR`, `*`, parens,
  > `AND`/`OR`, embedded quotes, and `col:` filters, all treated as inert literal
  > text with no error.
- [x] 3.2 Preserve the `Array<{id, rank}>` ordering contract consumed by hybrid RRF
  and the deterministic tie-break.
  > Preserved: `fullTextSearchFts5` returns `{ id, rank: -bm25Score }` (bm25 is lower-
  > is-better; negating keeps "higher rank = more relevant"), ordered via
  > `ORDER BY score ASC, t.id ASC` in SQL — the same "higher relevance first, id
  > ascending on ties" contract the LIKE path's JS sort already implemented.
  > `fullTextSearch`'s public signature/return type is unchanged, so every existing
  > caller (`search/index.ts`'s hybrid RRF, `pipeline/index.ts`'s dedup check) needs
  > no changes.
- [x] 3.3 Legacy fallback: when the probe fails, route to the existing LIKE
  implementation unchanged and surface the fallback in health (`sqlite` component
  `message`) and a structured warn log.
  > Both halves now implemented for real. Routing: `fullTextSearch` dispatches on
  > `this.ftsAvailable` to `fullTextSearchFts5` or `fullTextSearchLike` (the
  > unchanged legacy body, extracted verbatim into its own method); `ensureFtsSchema`
  > keeps `memories_fts` in the legacy plain-table shape whenever FTS5 is
  > unavailable (including rebuilding it from `memories` if a persisted FTS5 table
  > turns out to be unreadable on a build that no longer compiles fts5 — "degrade
  > gracefully and visibly", never fail closed). Visibility (unchanged from the prior
  > pass): `HealthService.checkSqlite()` adds a `message` to the `sqlite` component
  > and `index.ts` logs a structured `fts5_unavailable` warning once at startup, both
  > gated on `isFts5Available()`. Routing is now exercised directly (not just via
  > health-service mocks): `src/storage/sqlite.test.ts`'s "routes to the legacy
  > LIKE-based path when FTS5 is unavailable" test forces `ftsAvailable = false`,
  > calls the now-public-via-cast `ensureFtsSchema()` to rebuild the legacy table for
  > real, and asserts `fullTextSearch` still returns correct results through it.

## 4. Tests

- [x] 4.1 Stemming: "deployed" matches a memory containing "deployment".
  > Implemented with a corrected pair: SQLite's porter tokenizer does **not** stem
  > "deployment" to the same root as "deployed" (verified directly against an
  > `fts5vocab` table — "deployment" stems to "deploi", while "deployed"/
  > "deploying"/"deploys" all stem to "deploy"). Used "runs"/"running" instead (both
  > verified to stem to "run", and neither is a substring of the other, so the test
  > can only pass via real stemming, not accidental substring overlap). See
  > `src/storage/sqlite.test.ts`.
- [x] 4.2 Ranking: BM25 orders a short exact-match summary above a long body with
  scattered terms; column weighting asserted.
  > Implemented, with the scenario adjusted after empirical verification: BM25's
  > length normalization can dominate column weighting when the two documents' field
  > lengths differ a lot (verified directly — a long, low-density content match can
  > outrank a short summary match despite the 2x weight, because bm25's `b`
  > parameter penalizes long fields). The committed test holds content length equal
  > between the two documents so the column-weight effect is isolated and
  > unconfounded, and asserts the summary-match document ranks first. See
  > `src/storage/sqlite.test.ts`.
- [x] 4.3 Migration: a store seeded with legacy-table data returns identical-or-better
  results post-migration; migration is idempotent across restarts.
  > Implemented: `src/storage/sqlite.test.ts`'s migration test seeds a real memory via
  > the public API, then directly drops/recreates `memories_fts` in the pre-migration
  > legacy shape with deliberately wrong data, reopens the store (`reloadFromDisk()`)
  > and asserts `memories_fts` is now FTS5 and search results come from `memories`
  > (correct, stemmed) rather than the stale legacy row, then reopens a second time
  > and asserts the same results hold (idempotency).
- [x] 4.4 MATCH-syntax safety: queries containing FTS5 operators (`"`, `*`, `NEAR`,
  parens) do not error and are treated as literals.
  > Implemented: `src/storage/sqlite.test.ts` runs `fullTextSearch` with `NEAR`,
  > `"quoted"`, `foo*`, `(parens)`, `foo AND bar`, `a"b`, and `col:content` and
  > asserts none of them throw.
- [x] 4.5 Fallback: with the probe forced to fail, fulltext still works via the
  legacy path and health carries the message.
  > Implemented and tested. `src/storage/sqlite.test.ts` pins
  > `isFts5Available() === false` against the real, pinned sql.js build (a canary:
  > if this ever starts failing because the probe returns `true`, that's the signal
  > tasks 1.2-4.4 above can finally be built). `src/health/index.test.ts` adds two
  > tests exercising `HealthService` with `isFts5Available` mocked both `false` and
  > `true`, asserting the `sqlite` component message appears/is omitted accordingly.
  > Strengthened in this pass by the routing test under 3.3, which exercises the
  > real (not mocked) LIKE fallback path end to end.

## 5. Docs

- [x] 5.1 Update README ×5 (fulltext behavior: stemming, phrase notes) and
  `AGENTS.md` gotchas if relevant; bump `package.json` version.
  > Done for real this pass: README.md's "Fulltext Search" section, the Hybrid
  > Search mermaid diagram, and the query-expansion "Not applied to fulltext" note
  > now describe FTS5/porter stemming/BM25/MATCH-syntax sanitization/the LIKE
  > fallback, mirrored section-for-section into README.de.md, README.es.md,
  > README.fr.md, README.zh-CN.md (the health-endpoint fts5 paragraph in all five was
  > already accurate and needed no change). `AGENTS.md` gotcha #8 rewritten to
  > describe the actual FTS5/BM25 query path and LIKE fallback instead of the
  > "not implemented yet" state. `package.json` bumped `1.31.0` → `1.32.0`.
- [x] 5.2 `npm run lint` and `npm test` pass.
  > `npm run lint` (tsc --noEmit + eslint src) and `npm test` (950/950, 47 files)
  > both pass clean after every change in this pass, run from the repo root on
  > Node 24.13.1 (Windows). One `src/transport/http.test.ts` test
  > ("returns health without auth and uses 200/503 based on status") timed out once
  > under full-suite parallel load and passed cleanly when rerun in isolation and on
  > a subsequent full-suite run — a pre-existing timing flake unrelated to this
  > change (it exercises HTTP health-endpoint status codes, not storage/fulltext).
