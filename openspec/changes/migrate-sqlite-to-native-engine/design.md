## Context

`SqliteStore` is the system of record for all metadata. Its engine, `sql.js`, is an
in-process WASM SQLite that exists only in memory; persistence is
`flush()` → `db.export()` → whole-file atomic rewrite (`src/storage/sqlite.ts:422-425`),
and startup is a whole-file read (`init()`, :359-373). Two consequences define the
current design: every consumer must remember to call
`flushIfDirty()`/`scheduleDeferredFlush()` after mutating (the ~38 call sites across
`src/storage/index.ts`, `src/tools/index.ts`, `src/backup/*`,
`src/bootstrap/session.ts`, `src/cli/index.ts`, `src/resources/index.ts`,
`src/search/index.ts`), and durability is traded for throughput via a 5 s deferred
flush (`DEFERRED_FLUSH_MS`, :328). Separately, the WASM build compiles no FTS5
module, which stalls `upgrade-fulltext-to-fts5` at 3/14 tasks (probe and gate at
:344-353, :403-410).

Everything above the engine already treats `SqliteStorage`
(`src/storage/sqlite.ts:70-152`) as the seam: no caller touches the `sql.js`
`Database` object directly (the two test-file `initSqlJs` imports at
`src/bootstrap/session.test.ts:2` and `src/tools/bootstrap.test.ts:2` are unused).
That seam is what makes an engine swap tractable without touching call sites.

## Goals / Non-Goals

Goals:

- O(change-size) persisted mutations and O(1)-ish startup, independent of store size.
- Commit-level durability: a returned write survives process crash, with no deferred
  window.
- Zero changes at the ~38 `SqliteStorage` call sites; zero SQL dialect changes.
- Backup format (`.bhgb` header + raw SQLite image) and restore semantics preserved,
  including the checksum and memory-count cross-checks (`src/backup/index.ts:125,
  147-168`).
- An engine whose build ships FTS5, so `upgrade-fulltext-to-fts5` can proceed on the
  existing probe.

Non-Goals:

- Not implementing the FTS5 fulltext path itself — that stays in
  `upgrade-fulltext-to-fts5`; this change only makes its premise true.
- Not bumping `engines`/README Node floor — owned by
  `refresh-dependency-and-node-baseline` (parallel sibling); this proposal assumes it.
- No multi-process access to `brain.db`, no connection pooling, no async driver — the
  store stays single-connection, single-process, synchronous.
- No schema changes; `SCHEMA_SQL` and `ensureMemoryColumns()` migrations run as-is.

## Decisions

- **Engine: `node:sqlite` (`DatabaseSync`), not `better-sqlite3`.** Rationale:
  - Zero install weight: built into Node >=22 (unflagged since 22.13), which is
    already this repo's effective floor (`@qdrant/js-client-rest@1.19.0` engines
    `>=22`); `better-sqlite3` adds a native module with node-gyp fallback risk on
    Windows dev machines — this repo's primary dev environment.
  - Both are synchronous, so neither perturbs the synchronous `SqliteStorage`
    contract; API shapes are near-identical (`prepare().all()/get()/run()`).
  - `node:sqlite`'s API stability caveat (still marked experimental in Node 22.x)
    is mitigated two ways: the usage surface is tiny (open, `exec`, `prepare`,
    `all`/`get`/`run`, `close`) and confined to `SqliteStore` internals behind three
    private helpers (below), so a later swap to `better-sqlite3` is a one-file
    change; and the existing FTS5 probe stays authoritative rather than assuming
    engine capabilities.
  - If implementation hits a hard `node:sqlite` gap (e.g. a build without FTS5 on
    some platform), the fallback is `better-sqlite3` (compiles `SQLITE_ENABLE_FTS5`
    by default) — recorded here so the tasks don't need rewriting: only the helper
    internals and the dependency line change.
- **Private query helpers instead of a sprawling mechanical rewrite.** sql.js's
  statement idiom (`prepare` → `bind` → `step` → `getAsObject` → `free`) appears in
  ~114 lines across ~80 `this.db.prepare`/`this.db.run` sites. Introduce three
  private methods on `SqliteStore` — `execSql(sql, params)`, `queryAll(sql, params):
  SqlRow[]`, `queryOne(sql, params): SqlRow | null` — implemented on
  `DatabaseSync`, and convert call sites to them. Row shape stays `SqlRow`
  (`Record<string, SqlValue | undefined>`) so the existing `rowToMemory`-style
  mappers are untouched.
- **Pragmas at open**: `journal_mode=WAL`, `synchronous=NORMAL`. WAL+NORMAL makes
  every commit durable across application crash (the current failure mode the
  deferred flush loses data to) while only risking the last commits on OS/power
  failure — strictly better than today's 5 s window plus non-fsynced
  `writeFileSync`. `flush()` becomes `PRAGMA wal_checkpoint(PASSIVE)`;
  `flushIfDirty()`/`scheduleDeferredFlush()`/`cancelDeferredFlush()` become no-ops
  (the `dirty` flag and timer are deleted). Methods stay on the interface so no call
  site changes.
- **`close()` checkpoints TRUNCATE first** (`src/storage/sqlite.ts:1560-1564`): the
  main `brain.db` file is then self-contained (no `-wal` sidecar needed), keeping
  the file readable by whole-file readers (old sql.js builds, external inspection
  tools) after a clean shutdown.
- **`exportData()` via `VACUUM INTO`**: `DatabaseSync` has no `serialize()`;
  `VACUUM INTO '<tmp>'` writes a compacted, standalone, checkpointed image that the
  backup format embeds unchanged (`src/backup/index.ts:59`). Write the temp file
  inside `dataDir` (same volume), read bytes, unlink. The restore-side
  `memory_count` cross-check is unaffected — `VACUUM INTO` preserves content
  exactly, merely compacted.
- **Restore must close-before-overwrite.** Today `BackupService.restore()` writes
  the new image onto `brain.db` (`atomicWriteFileSync`, `src/backup/index.ts:131`)
  while the store is open, then activates via
  `StorageManager.reloadSqliteFromDisk()` (`src/storage/index.ts:391-393`) →
  `SqliteStore.reloadFromDisk()` (`src/storage/sqlite.ts:375-392`), which closes the
  old handle only afterward. Harmless for memory-only sql.js; on Windows with a
  native engine holding an open file handle, the rename fails (EPERM). Fix by
  restructuring `reloadFromDisk()` into the activation primitive: add
  `SqliteStore.activateDatabaseImage(image: Buffer)` (close connection → remove
  stale `-wal`/`-shm` → atomic-write image → reopen with pragmas → migrations →
  probe), and have `restore()` call it instead of writing the file itself.
  `reloadFromDisk()` remains for any path that only needs re-open, likewise
  closing before reopening and clearing sidecar files.
- **On-disk compatibility is one-directional by design.** Existing `brain.db` files
  written by sql.js are standard SQLite 3 images — `DatabaseSync` opens them
  directly; the first open flips them to WAL. No data migration step exists or is
  needed. Rolling back to a sql.js build requires a clean shutdown first (TRUNCATE
  checkpoint) — documented, not engineered around.
- **FTS5 probe stays; expectations flip.** `probeFts5Support()`
  (`src/storage/sqlite.ts:403-410`) is engine-agnostic and remains the single
  authority. On Node's FTS5-enabled build it returns `true`, so: the canary test
  (`src/storage/sqlite.test.ts:78-81`) inverts per its own comment ("if this ever
  starts failing because the probe now returns true, that is good news"), and
  `HealthService.checkSqlite`'s legacy-fulltext message
  (`src/health/index.ts:76-81`) stops appearing. Note `fullTextSearch` still runs
  the LIKE matcher until `upgrade-fulltext-to-fts5` lands its query path — the
  health message keys on *capability*, not usage, and that proposal owns closing
  the gap.
- **Lock-retry stance unchanged.** The documented no-retry decision
  (`src/storage/sqlite.ts:323-337`) survives with updated wording: still one
  connection in one process, so no writer contention; WAL's busy conditions cannot
  arise against ourselves. `beginLifecycleOperation`/`assertMutableAllowed` guards
  are engine-independent and unchanged.

## Risks / Trade-offs

- **`node:sqlite` experimental status**: API surface could shift across Node minors.
  Bounded by the three-helper indirection and the documented `better-sqlite3`
  fallback; CI (`npm test`) exercises the whole store surface on every run.
- **WAL sidecar files** (`brain.db-wal`, `brain.db-shm`) appear next to the
  database. Backup (`exportData`) is unaffected (`VACUUM INTO` is self-contained),
  but any operator habit of copying `brain.db` alone while the server runs was
  already unsafe and remains so; clean shutdown truncates the WAL. Restore must
  delete stale sidecars before activating a new image or the old WAL would corrupt
  it — handled in `activateDatabaseImage`.
- **Behavioral drift risk in the mechanical rewrite** (~80 statement sites): the
  strongest mitigation is that the existing test suite pins the `SqliteStorage`
  contract per method; the rewrite changes no SQL text, only execution plumbing.
- **Crash-window semantics change shape**: today a crash loses up to 5 s of
  acknowledged writes but the previous file image is always intact; with WAL+NORMAL
  an OS-level crash can lose the tail of the WAL (never corrupting the main image).
  Application-crash durability strictly improves; power-loss durability is
  comparable-or-better and no longer includes acknowledged-write loss.
- **Sequencing with `refresh-dependency-and-node-baseline`**: if this lands first,
  `package.json` still claims `>=20.0.0` while the code imports `node:sqlite`
  (absent on 20). Acceptable for the short overlap because the Qdrant client
  already makes Node 20 installs fail EBADENGINE, but the tasks call for verifying
  the sibling's engines bump has landed — or noting it loudly in the PR — rather
  than silently shipping a mismatched floor.
