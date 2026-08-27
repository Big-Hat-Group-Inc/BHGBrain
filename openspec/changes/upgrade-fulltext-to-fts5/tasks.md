## 1. FTS5 table and probe

- [x] 1.1 Add a startup FTS5 capability probe (attempt `CREATE VIRTUAL TABLE ... USING
  fts5` in a temp schema); record the result on the store instance.
  > Implemented: `SqliteStore.probeFts5Support()` (`src/storage/sqlite.ts`), run in
  > both `init()` and `reloadFromDisk()`, result cached on `ftsAvailable` and exposed
  > via `isFts5Available()`. Verified empirically (see note below) to correctly
  > return `false` against the pinned sql.js build.
- [ ] 1.2 Define the FTS5 virtual table (`tokenize='porter unicode61'`) with content,
  summary, tags as searchable columns and namespace/collection as UNINDEXED filter
  columns; document that it is derived data rebuildable from `memories`.
  > **Premise does not hold for the pinned dependency.** `sql.js@^1.12.0` (resolved
  > `1.14.1`) does not compile the SQLite `fts5` module into its wasm build — verified
  > directly: `db.run("CREATE VIRTUAL TABLE t USING fts5(a, b)")` throws `no such
  > module: fts5`, and the shipped `sql-wasm.wasm` contains no `fts5` /
  > `SQLITE_ENABLE_FTS5` strings (FTS3 is present, FTS5 is not). The proposal's "Why"
  > section states "sql.js compiles SQLite with FTS5 available" — that is not true of
  > the actual npm-distributed build this repo depends on. Defining a real FTS5 table
  > DDL that can never be created or exercised in this repository (not even manually —
  > `npm test` uses the same sql.js build as production) would be unverified/dead
  > code, so I left it unimplemented rather than writing SQL nobody can run or test.
  > Left unchecked per the "premise is wrong" guidance rather than forced.
- [ ] 2.1 Idempotent startup migration: detect the legacy plain `memories_fts` table,
  create the FTS5 table, batch-backfill from `memories`, and swap; safe to re-run and
  safe to interrupt (rebuild from source of truth).
  > Blocked on 1.2 for the same reason — there is no FTS5 table to migrate to.
  > Unchecked.
- [ ] 2.2 Maintain the FTS index on every memory insert/update/delete/archive path in
  `src/storage/sqlite.ts` (including restore/repair bulk paths).
  > Blocked on 1.2/2.1. The legacy `memories_fts` plain-table write-through hooks
  > (insert/update/delete/upsertMemoryFromPayload/deleteMemoriesInCollection) are
  > unchanged and still correct — there is simply no second (FTS5) table to maintain
  > in parallel. Unchecked.

## 2. Migration and write-path maintenance

(See 2.1/2.2 above, left under section 1 for shared context — task IDs preserved.)

## 3. Query path

- [ ] 3.1 Reimplement `fullTextSearch` on FTS5 MATCH + `bm25()` with column weights
  preserving the summary/tags > content intent; escape/sanitize user query into FTS5
  MATCH syntax safely (no raw query-string injection into MATCH).
  > Blocked on 1.2 — there is no FTS5 table/MATCH surface to query. `fullTextSearch`
  > is unchanged (still the LIKE-based term-frequency ranker). Unchecked.
- [ ] 3.2 Preserve the `Array<{id, rank}>` ordering contract consumed by hybrid RRF
  and the deterministic tie-break.
  > Not applicable yet — nothing changed in `fullTextSearch`'s signature or ordering
  > behavior, so the existing contract is trivially preserved, but there is no BM25
  > ranking to verify the contract survives under. Unchecked (no new work to check
  > off).
- [ ] 3.3 Legacy fallback: when the probe fails, route to the existing LIKE
  implementation unchanged and surface the fallback in health (`sqlite` component
  `message`) and a structured warn log.
  > **Partially implemented.** The "surface the fallback" half is done and tested:
  > `HealthService.checkSqlite()` (`src/health/index.ts`) now adds a `message` to the
  > `sqlite` health component when `isFts5Available()` is `false` (status stays
  > `"healthy"` — this is today's expected steady state, not a fault), and `index.ts`
  > logs a structured `fts5_unavailable` warning once at startup under the same
  > condition. The "route to the existing LIKE implementation" half is vacuous rather
  > than implemented: there is only one implementation (LIKE-based) because 3.1 was
  > not built, so there is no routing/branching logic to point at it. Left unchecked
  > because the task as written presupposes a real dual-path router.

## 4. Tests

- [ ] 4.1 Stemming: "deployed" matches a memory containing "deployment".
  > Cannot be exercised: requires a real FTS5 porter-tokenized index, which cannot be
  > created against the pinned sql.js build (see 1.2). Unchecked.
- [ ] 4.2 Ranking: BM25 orders a short exact-match summary above a long body with
  scattered terms; column weighting asserted.
  > Cannot be exercised for the same reason — no `bm25()` function is reachable
  > without a real FTS5 table. Unchecked.
- [ ] 4.3 Migration: a store seeded with legacy-table data returns identical-or-better
  results post-migration; migration is idempotent across restarts.
  > Cannot be exercised — there is no migration (2.1) to test. Unchecked.
- [ ] 4.4 MATCH-syntax safety: queries containing FTS5 operators (`"`, `*`, `NEAR`,
  parens) do not error and are treated as literals.
  > Cannot be exercised — there is no MATCH-syntax sanitizer (3.1) to test.
  > Unchecked.
- [x] 4.5 Fallback: with the probe forced to fail, fulltext still works via the
  legacy path and health carries the message.
  > Implemented and tested. `src/storage/sqlite.test.ts` pins
  > `isFts5Available() === false` against the real, pinned sql.js build (a canary:
  > if this ever starts failing because the probe returns `true`, that's the signal
  > tasks 1.2–4.4 above can finally be built). `src/health/index.test.ts` adds two
  > tests exercising `HealthService` with `isFts5Available` mocked both `false` and
  > `true`, asserting the `sqlite` component message appears/is omitted accordingly.
  > `fullTextSearch` itself is untouched, so its many existing passing tests already
  > cover "still works via the legacy path".

## 5. Docs

- [ ] 5.1 Update README ×5 (fulltext behavior: stemming, phrase notes) and
  `AGENTS.md` gotchas if relevant; bump `package.json` version.
  > **Partially done, left unchecked because the task's core ask isn't met.** There
  > is no stemming/phrase behavior to document — fulltext search is unchanged
  > (still LIKE-based, no porter tokenizer, no BM25). What *did* ship is a new,
  > user-visible health signal, so: README ×5 each gained a sentence under
  > "Health Endpoint" documenting that `components.sqlite` can carry an
  > `fts5_unavailable`-flavored `message` while staying `"healthy"`; `AGENTS.md`
  > gained gotcha #9 documenting that the pinned sql.js build has no fts5 module
  > (so future work doesn't re-assume the proposal's premise); `package.json`
  > bumped `1.9.0` → `1.9.1`. Left unchecked because the fulltext-behavior
  > documentation this task actually asks for doesn't exist to write.
- [x] 5.2 `npm run lint` and `npm test` pass.
  > `npm run lint` (tsc --noEmit + eslint src) and `npm test` (478/478, 29 files)
  > both pass clean after every change in this pass.
