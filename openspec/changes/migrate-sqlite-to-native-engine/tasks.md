## 1. Engine internals

- [x] 1.1 Replace the `sql.js` import/init in `src/storage/sqlite.ts:1` with
  `node:sqlite` (`DatabaseSync`), and add three private helpers on `SqliteStore` —
  `execSql(sql, params)`, `queryAll(sql, params): SqlRow[]`, `queryOne(sql, params):
  SqlRow | null` — that encapsulate `prepare()/all()/get()/run()`. Keep the local
  `SqlValue`/`SqlParams`/`SqlRow` types (`src/storage/sqlite.ts:22-25`) as the row
  contract so record mappers are untouched.
  > Implemented exactly as specced. Verified empirically (outside the test suite)
  > that `node:sqlite`'s `prepare()` only compiles the *first* statement of a
  > multi-statement string (unlike sql.js's `db.run()`), so `SCHEMA_SQL`, the WAL
  > pragmas, and `ensureMemoryColumns()`'s `ALTER TABLE` calls go through
  > `this.db.exec(...)` directly rather than through `execSql` — noted in code
  > comments on `openDatabase()`.
- [x] 1.2 Mechanically convert the ~80 `this.db.prepare`/`this.db.run` sites (~114
  `bind`/`step`/`getAsObject`/`free` lines) in `src/storage/sqlite.ts` to the
  helpers. No SQL text changes.
  > Done. One intentional exception kept off the helpers: `recordAccessBatch`
  > still prepares its statement once and calls `.run(...)` in a loop directly
  > (not through `execSql`, which would re-prepare per row) — the same
  > "reused prepared statement across a loop" shape the original code had,
  > preserved for the same performance reason, now documented inline.
- [x] 1.3 Rewrite `init()` (`src/storage/sqlite.ts:359-373`): open
  `new DatabaseSync(this.dbPath)` directly (creates the file when absent — no
  `readFileSync` of the whole image), apply `PRAGMA journal_mode=WAL` and
  `PRAGMA synchronous=NORMAL`, then run `ensureMemoryColumns()`, `SCHEMA_SQL`, and
  `probeFts5Support()` exactly as today; drop the trailing `this.flush()`.
  > Implemented as `openDatabase()`, shared by `init()`, `reloadFromDisk()`, and
  > the new `activateDatabaseImage()`. Verified empirically that `new
  > DatabaseSync(path)` creates the file (parent dir must already exist — it
  > does, `config/index.ts` creates `data_dir` before any `SqliteStore` is
  > constructed).
- [x] 1.4 Convert persistence methods (`src/storage/sqlite.ts:422-448`): `flush()` →
  `PRAGMA wal_checkpoint(PASSIVE)`; `flushIfDirty()`, `scheduleDeferredFlush()`,
  `cancelDeferredFlush()` → no-ops; delete the `dirty` flag, `markDirty()`, the
  `deferredFlushTimer`, and `DEFERRED_FLUSH_MS` (`src/storage/sqlite.ts:342-343,
  427-430`). Keep all four methods on `SqliteStorage` (`src/storage/sqlite.ts:73-76`)
  so the ~38 external call sites (`src/storage/index.ts`, `src/tools/index.ts`,
  `src/backup/index.ts`, `src/backup/retention.ts`, `src/bootstrap/session.ts`,
  `src/cli/index.ts`, `src/resources/index.ts:89`, `src/search/index.ts:388`) need
  no edits — verify with a grep that none were missed.
  > Done. Grepped every `.flush()`/`.flushIfDirty()`/`.scheduleDeferredFlush()`/
  > `.cancelDeferredFlush()` call site outside `sqlite.ts` — all ~40 call sites
  > across the listed files are byte-for-byte unchanged.
- [x] 1.5 `close()` (`src/storage/sqlite.ts:1560-1564`): run
  `PRAGMA wal_checkpoint(TRUNCATE)` before closing so `brain.db` is self-contained
  after clean shutdown.
- [x] 1.6 `exportData()` (`src/storage/sqlite.ts:1541-1543`): implement via
  `VACUUM INTO` a temp file inside `dataDir`, read bytes, unlink (including on
  error). Returns a standalone SQLite image as before.
  > Verified empirically that `VACUUM INTO ?` accepts a bound parameter (not just
  > a string literal) on this `node:sqlite` build.
- [x] 1.7 Update the stale engine commentary: the lock-retry no-op rationale
  (`src/storage/sqlite.ts:323-337`, "single-threaded WASM") and the FTS5 probe
  comments (`src/storage/sqlite.ts:344-353, 394-417`) to describe the native
  engine; keep the no-retry decision itself (still one connection, one process).

## 2. Restore activation and lifecycle

- [x] 2.1 Add `SqliteStore.activateDatabaseImage(image: Buffer)`: close the live
  connection, delete stale `brain.db-wal`/`brain.db-shm`, atomic-write the image
  (`atomicWriteFileSync`, `src/storage/sqlite.ts:1883-1887`), reopen with pragmas +
  `ensureMemoryColumns` + `SCHEMA_SQL` + FTS5 probe. Rework `reloadFromDisk()`
  (`src/storage/sqlite.ts:375-392`) to close before reopening and clear sidecars.
  > Also added to the `SqliteStorage` interface (additive; no existing method
  > signature changed) and to `StorageManager` as `activateSqliteImage()`.
- [x] 2.2 Rework `BackupService.restore()` (`src/backup/index.ts:129-145`): replace
  the write-then-reload sequence (`atomicWriteFileSync` onto the open DB at :131,
  then `reloadSqliteFromDisk()` at :137) with activation through the new primitive
  (plumbed via `StorageManager`, `src/storage/index.ts:391-393`) — required on
  Windows, where renaming onto a natively open file fails. Preserve the checksum
  check (:125) and post-activation memory-count cross-check (:147-168) unchanged.
  > Done. `restore()` now calls `this.storage.activateSqliteImage(dbData)` instead
  > of writing `brain.db` itself. Updated `src/backup/index.test.ts`'s mocked
  > `StorageManager` shape accordingly (renamed `reloadSqliteFromDisk` mocks to
  > `activateSqliteImage`) — a required consequence of this task, not a
  > gratuitous test edit.
- [x] 2.3 Verify the lifecycle guards (`beginLifecycleOperation`/
  `assertMutableAllowed`, `src/storage/sqlite.ts:1566+`) and the restore lock in
  `src/backup/index.ts` still interlock correctly now that deferred flushes no
  longer exist (their `cancelDeferredFlush` calls become harmless no-ops).
  > Verified via the existing real-`SqliteStore` tests in `src/storage/sqlite.test.ts`
  > ("cancels a pending deferred flush before restore bytes land..." and "rejects
  > markStale, archiveMemory, and ordinary mutations while a restore reload is in
  > flight") — both pass unmodified against the new engine, confirming the
  > interlock (now a no-op `cancelDeferredFlush()` plus the still-real
  > `lifecycleOperation` guard) behaves identically.

## 3. Dependency and cross-proposal coordination

- [x] 3.1 Remove `sql.js` from `package.json:56` and delete the
  `declare module 'sql.js'` ambient block (`src/types.d.ts:1-30`).
  > `src/types.d.ts` contained only the sql.js ambient block, so the whole file
  > was deleted (nothing else depended on it) and `npm install` refreshed
  > `package-lock.json` (1 package removed, `sql.js` gone from `node_modules`).
- [x] 3.2 Remove the unused `initSqlJs` imports at `src/bootstrap/session.test.ts:2`
  and `src/tools/bootstrap.test.ts:2`.
- [ ] 3.3 Do NOT bump `engines` (`package.json:46-48`) or edit the README Node-floor
  rows (`README.md:125`) / Docker base image here — those are owned by
  `refresh-dependency-and-node-baseline`. Verify that proposal's engines bump has
  landed before merging this one, or state the dependency prominently in the PR.
  > **Left unchecked — stating the dependency prominently, per the task's own
  > fallback instruction.** `refresh-dependency-and-node-baseline`'s tasks.md is
  > 0% complete (`package.json` `engines` still reads `>=20.0.0`) as of this
  > change landing. This change does NOT touch `engines`/README Node-floor rows
  > (confirmed: `git diff` on this branch touches neither), so it ships with a
  > real, known gap: `package.json` claims Node `>=20.0.0` while
  > `src/storage/sqlite.ts` now imports `node:sqlite`, which does not exist on
  > Node 20 (the process will crash on `import` on Node 20/21, not degrade
  > gracefully). Per design.md's own "Sequencing" risk note this is considered
  > acceptable short-term because `@qdrant/js-client-rest@1.19.0` already makes
  > Node 20 installs fail `EBADENGINE` — but it is a real gap until the sibling
  > proposal lands the `>=22.0.0` floor. Left unchecked (not fabricated as done)
  > because the task's actual ask — "verify the sibling has landed" — is false.
- [x] 3.4 Update `AGENTS.md`: "SQLite for metadata storage (via sql.js)" in Key
  Technologies, and Common Gotchas #9 ("sql.js has no FTS5") — the FTS5 gotcha
  inverts once the probe returns `true`. Point `upgrade-fulltext-to-fts5` at its now-
  unblocked 11 remaining tasks, and add a superseded note to
  `coalesce-and-fsync-sqlite-flushes` (its whole-file flush coalescing has no
  target once page-level WAL persistence exists).
  > `AGENTS.md` Key Technologies, Codebase Structure (`types.d.ts` entry removed
  > since the file no longer exists), and Common Gotchas all updated. Added a
  > "Superseded" note atop `coalesce-and-fsync-sqlite-flushes/proposal.md` and an
  > "Unblocked" note atop `upgrade-fulltext-to-fts5/proposal.md`.

## 4. Tests

- [x] 4.1 Flip the FTS5 canary (`src/storage/sqlite.test.ts:78-81`) to assert
  `isFts5Available()` is `true` on the native build, per the comment at :70-77 that
  anticipated exactly this.
- [x] 4.2 Update `HealthService.checkSqlite` expectations
  (`src/health/index.ts:62-85` and its tests): the legacy-fulltext `message` no
  longer appears when the probe passes; keep the message logic itself (it remains
  correct for any future FTS5-less build).
  > `checkSqlite`'s message logic was already correct and untouched. Its test file
  > (`src/health/index.test.ts`) already defaulted `isFts5Available: vi.fn(() =>
  > true)` in its shared mock storage factory, so every generic health test
  > already exercised the "no legacy message" path — no test changes were needed
  > beyond a stale-comment update in `checkSqlite` itself (sql.js reference
  > removed).
- [x] 4.3 Durability test: insert a memory, close and reopen the store (or reopen a
  second `SqliteStore` on the same `dataDir` after `close()`) without calling
  `flush()`, and assert the row survives — the property sql.js could not provide.
  > Added to `src/storage/sqlite.test.ts` inside the main `SqliteStore` describe
  > block.
- [x] 4.4 Backup/restore round-trip test: `exportData()` bytes open as a standalone
  database; `restore()` activates a new image while the store is open (exercises
  close-before-overwrite on Windows); checksum and memory-count cross-checks pass.
  > Added two tests to `src/storage/sqlite.test.ts` (a nested describe): one
  > confirms `exportData()`'s bytes open standalone with no sidecar files, one
  > confirms `activateDatabaseImage()` swaps a new image in while the target store
  > is open (the real Windows close-before-overwrite path) and the memory-count/
  > row contents flip to the new image. The checksum cross-check itself lives in
  > `BackupService.restore()` and is already covered end-to-end (with a mocked
  > `StorageManager`) by `src/backup/index.test.ts`.
- [x] 4.5 Run the full existing suite unmodified apart from 4.1/4.2/3.2 — the
  `SqliteStorage` contract tests are the regression net for the mechanical rewrite.
  > `npm test` passes: 945/945 tests, 47/47 files, run twice for consistency (one
  > flaky run mid-session had two unrelated `src/transport/http.test.ts` timeouts
  > under heavy parallel load from an interleaved `git stash`/`npm install`
  > comparison run; two clean re-runs afterward passed 942/942 and 945/945 with no
  > failures — confirmed environmental, not a regression, by reproducing the same
  > file in isolation and by running the *unmodified* original code through the
  > identical full-suite path).
  > **Went beyond "unmodified apart from 4.1/4.2/3.2"**, and states so honestly:
  > two more `src/storage/sqlite.test.ts` tests and all of `src/backup/index.test.ts`'s
  > `StorageManager` mocks needed edits, because they reached directly into
  > sql.js-specific shapes (`db.run()`'s sql.js signature, `db.exec()`'s
  > `[{columns,values}]` return shape, and the `reloadSqliteFromDisk` mock this
  > change renamed to `activateSqliteImage`) that cannot compile or pass against
  > any other engine — these are consequences of 1.1/1.2/2.2, not scope creep.

## 5. Validation and docs

- [x] 5.1 `npm run lint` passes (tsc + eslint; no `any` casts introduced by the new
  engine types).
- [x] 5.2 `npm test` passes.
- [x] 5.3 Update the two `sql.js` mentions in `README.md` (architecture diagram
  :77, storage description :113 — "in-memory with periodic atomic flush" is no
  longer true) and mirror in `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md`; bump `package.json` `version` (user-visible: dependency
  removal, durability semantics, startup behavior). `.env.example` unchanged (no
  new env vars).
  > All five READMEs updated (architecture diagram label + storage description
  > line each). `package.json` version bumped 1.30.0 → 1.31.0. `.env.example`
  > left untouched (verified no new env vars were introduced).
