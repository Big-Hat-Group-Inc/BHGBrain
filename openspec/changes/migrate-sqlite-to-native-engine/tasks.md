## 1. Engine internals

- [ ] 1.1 Replace the `sql.js` import/init in `src/storage/sqlite.ts:1` with
  `node:sqlite` (`DatabaseSync`), and add three private helpers on `SqliteStore` —
  `execSql(sql, params)`, `queryAll(sql, params): SqlRow[]`, `queryOne(sql, params):
  SqlRow | null` — that encapsulate `prepare()/all()/get()/run()`. Keep the local
  `SqlValue`/`SqlParams`/`SqlRow` types (`src/storage/sqlite.ts:22-25`) as the row
  contract so record mappers are untouched.
- [ ] 1.2 Mechanically convert the ~80 `this.db.prepare`/`this.db.run` sites (~114
  `bind`/`step`/`getAsObject`/`free` lines) in `src/storage/sqlite.ts` to the
  helpers. No SQL text changes.
- [ ] 1.3 Rewrite `init()` (`src/storage/sqlite.ts:359-373`): open
  `new DatabaseSync(this.dbPath)` directly (creates the file when absent — no
  `readFileSync` of the whole image), apply `PRAGMA journal_mode=WAL` and
  `PRAGMA synchronous=NORMAL`, then run `ensureMemoryColumns()`, `SCHEMA_SQL`, and
  `probeFts5Support()` exactly as today; drop the trailing `this.flush()`.
- [ ] 1.4 Convert persistence methods (`src/storage/sqlite.ts:422-448`): `flush()` →
  `PRAGMA wal_checkpoint(PASSIVE)`; `flushIfDirty()`, `scheduleDeferredFlush()`,
  `cancelDeferredFlush()` → no-ops; delete the `dirty` flag, `markDirty()`, the
  `deferredFlushTimer`, and `DEFERRED_FLUSH_MS` (`src/storage/sqlite.ts:342-343,
  427-430`). Keep all four methods on `SqliteStorage` (`src/storage/sqlite.ts:73-76`)
  so the ~38 external call sites (`src/storage/index.ts`, `src/tools/index.ts`,
  `src/backup/index.ts`, `src/backup/retention.ts`, `src/bootstrap/session.ts`,
  `src/cli/index.ts`, `src/resources/index.ts:89`, `src/search/index.ts:388`) need
  no edits — verify with a grep that none were missed.
- [ ] 1.5 `close()` (`src/storage/sqlite.ts:1560-1564`): run
  `PRAGMA wal_checkpoint(TRUNCATE)` before closing so `brain.db` is self-contained
  after clean shutdown.
- [ ] 1.6 `exportData()` (`src/storage/sqlite.ts:1541-1543`): implement via
  `VACUUM INTO` a temp file inside `dataDir`, read bytes, unlink (including on
  error). Returns a standalone SQLite image as before.
- [ ] 1.7 Update the stale engine commentary: the lock-retry no-op rationale
  (`src/storage/sqlite.ts:323-337`, "single-threaded WASM") and the FTS5 probe
  comments (`src/storage/sqlite.ts:344-353, 394-417`) to describe the native
  engine; keep the no-retry decision itself (still one connection, one process).

## 2. Restore activation and lifecycle

- [ ] 2.1 Add `SqliteStore.activateDatabaseImage(image: Buffer)`: close the live
  connection, delete stale `brain.db-wal`/`brain.db-shm`, atomic-write the image
  (`atomicWriteFileSync`, `src/storage/sqlite.ts:1883-1887`), reopen with pragmas +
  `ensureMemoryColumns` + `SCHEMA_SQL` + FTS5 probe. Rework `reloadFromDisk()`
  (`src/storage/sqlite.ts:375-392`) to close before reopening and clear sidecars.
- [ ] 2.2 Rework `BackupService.restore()` (`src/backup/index.ts:129-145`): replace
  the write-then-reload sequence (`atomicWriteFileSync` onto the open DB at :131,
  then `reloadSqliteFromDisk()` at :137) with activation through the new primitive
  (plumbed via `StorageManager`, `src/storage/index.ts:391-393`) — required on
  Windows, where renaming onto a natively open file fails. Preserve the checksum
  check (:125) and post-activation memory-count cross-check (:147-168) unchanged.
- [ ] 2.3 Verify the lifecycle guards (`beginLifecycleOperation`/
  `assertMutableAllowed`, `src/storage/sqlite.ts:1566+`) and the restore lock in
  `src/backup/index.ts` still interlock correctly now that deferred flushes no
  longer exist (their `cancelDeferredFlush` calls become harmless no-ops).

## 3. Dependency and cross-proposal coordination

- [ ] 3.1 Remove `sql.js` from `package.json:56` and delete the
  `declare module 'sql.js'` ambient block (`src/types.d.ts:1-30`).
- [ ] 3.2 Remove the unused `initSqlJs` imports at `src/bootstrap/session.test.ts:2`
  and `src/tools/bootstrap.test.ts:2`.
- [ ] 3.3 Do NOT bump `engines` (`package.json:46-48`) or edit the README Node-floor
  rows (`README.md:125`) / Docker base image here — those are owned by
  `refresh-dependency-and-node-baseline`. Verify that proposal's engines bump has
  landed before merging this one, or state the dependency prominently in the PR.
- [ ] 3.4 Update `AGENTS.md`: "SQLite for metadata storage (via sql.js)" in Key
  Technologies, and Common Gotchas #9 ("sql.js has no FTS5") — the FTS5 gotcha
  inverts once the probe returns `true`. Point `upgrade-fulltext-to-fts5` at its now-
  unblocked 11 remaining tasks, and add a superseded note to
  `coalesce-and-fsync-sqlite-flushes` (its whole-file flush coalescing has no
  target once page-level WAL persistence exists).

## 4. Tests

- [ ] 4.1 Flip the FTS5 canary (`src/storage/sqlite.test.ts:78-81`) to assert
  `isFts5Available()` is `true` on the native build, per the comment at :70-77 that
  anticipated exactly this.
- [ ] 4.2 Update `HealthService.checkSqlite` expectations
  (`src/health/index.ts:62-85` and its tests): the legacy-fulltext `message` no
  longer appears when the probe passes; keep the message logic itself (it remains
  correct for any future FTS5-less build).
- [ ] 4.3 Durability test: insert a memory, close and reopen the store (or reopen a
  second `SqliteStore` on the same `dataDir` after `close()`) without calling
  `flush()`, and assert the row survives — the property sql.js could not provide.
- [ ] 4.4 Backup/restore round-trip test: `exportData()` bytes open as a standalone
  database; `restore()` activates a new image while the store is open (exercises
  close-before-overwrite on Windows); checksum and memory-count cross-checks pass.
- [ ] 4.5 Run the full existing suite unmodified apart from 4.1/4.2/3.2 — the
  `SqliteStorage` contract tests are the regression net for the mechanical rewrite.

## 5. Validation and docs

- [ ] 5.1 `npm run lint` passes (tsc + eslint; no `any` casts introduced by the new
  engine types).
- [ ] 5.2 `npm test` passes.
- [ ] 5.3 Update the two `sql.js` mentions in `README.md` (architecture diagram
  :77, storage description :113 — "in-memory with periodic atomic flush" is no
  longer true) and mirror in `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md`; bump `package.json` `version` (user-visible: dependency
  removal, durability semantics, startup behavior). `.env.example` unchanged (no
  new env vars).
