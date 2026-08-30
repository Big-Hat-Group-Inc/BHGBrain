## Why

The SQLite layer runs on `sql.js`, a WASM build that holds the entire database in
memory and persists it by rewriting the whole file:

- `SqliteStore.flush()` (`src/storage/sqlite.ts:422-425`) calls `this.db.export()` —
  a full serialization of the in-memory database — and synchronously rewrites
  `brain.db` via `atomicWriteFileSync` (`src/storage/sqlite.ts:1883-1887`). Every
  persisted mutation therefore costs O(total DB size), not O(change size): at 100k
  memories the image (with the `memories_fts` shadow table) reaches hundreds of MB,
  and every `remember`/`forget`/`tag` blocks the event loop for hundreds of ms while
  it re-serializes and rewrites all of it.
- `init()` (`src/storage/sqlite.ts:359-373`) reads the entire file back into memory
  on every start (`readFileSync` at :361-363), so startup time and baseline RSS also
  scale with total store size.
- The 5-second deferred-flush window (`scheduleDeferredFlush`,
  `src/storage/sqlite.ts:436-443`) exists only to amortize that rewrite cost — and
  buys it by accepting up to 5 s of committed-but-unpersisted writes lost on crash.
- The pinned sql.js build compiles no FTS5 module, which is the sole blocker on
  `upgrade-fulltext-to-fts5`'s remaining 11 tasks (gate documented at
  `src/storage/sqlite.ts:344-353`; probe at :403-410 is real and engine-agnostic).

Meanwhile the effective runtime floor is already Node 22:
`@qdrant/js-client-rest@1.19.0` declares `engines >=22` (EBADENGINE on 20, per
CLAUDE.md), even though `package.json:47` still says `>=20.0.0`. On Node 22,
`node:sqlite` is built into the runtime — a native engine gives WAL page-level
writes, real fsync durability, no startup full-file read, and bundled FTS5, for zero
added install weight.

## What Changes

- Reimplement `SqliteStore` (`src/storage/sqlite.ts`) on `node:sqlite`'s
  `DatabaseSync` (decision and alternative — `better-sqlite3` — argued in
  `design.md`), opened directly on `brain.db` with `journal_mode=WAL` and
  `synchronous=NORMAL`.
- Keep the `SqliteStorage` interface (`src/storage/sqlite.ts:70-152`) byte-for-byte
  stable: `flush()`/`flushIfDirty()` become WAL checkpoints/no-ops and
  `scheduleDeferredFlush()`/`cancelDeferredFlush()` become no-ops, so the ~38
  external call sites (`src/storage/index.ts`, `src/tools/index.ts`,
  `src/backup/*`, `src/bootstrap/session.ts`, `src/cli/index.ts`,
  `src/resources/index.ts`, `src/search/index.ts`) need no change.
- Keep `exportData()` (`src/storage/sqlite.ts:1541-1543`) producing a standalone
  SQLite image for the backup format, via `VACUUM INTO` a temp file.
- Rework restore activation ordering (`src/backup/index.ts:129-145`): the live
  native connection must be closed before `brain.db` is overwritten (rename onto an
  open file fails on Windows), where sql.js — memory-only — never cared.
- Drop the `sql.js` dependency (`package.json:56`) and its ambient declarations
  (`src/types.d.ts:1-29`).
- Update the FTS5 canary test (`src/storage/sqlite.test.ts:78-81`) and the
  `HealthService.checkSqlite` legacy-fulltext message expectations
  (`src/health/index.ts:62-85`): the probe flips to `true` on an FTS5-enabled build.
- **Not in scope here**: the `engines` bump to `>=22` and the README/Dockerfile Node-
  floor edits are owned by the sibling proposal `refresh-dependency-and-node-baseline`
  (authored in parallel); this change depends on that floor and references it rather
  than duplicating its tasks. This change also supersedes the interim
  `coalesce-and-fsync-sqlite-flushes` proposal (flush coalescing/fsync hardening for
  the sql.js whole-file writer): once page-level WAL persistence lands there is no
  whole-file flush left to coalesce.

## Capabilities

### New Capabilities

- `native-sqlite-persistence`: metadata persistence runs on a native SQLite engine
  with WAL journaling — mutations cost O(change), commits are durable without a
  deferred-flush loss window, startup does not read the whole database into memory,
  and the engine ships FTS5 (unblocking `upgrade-fulltext-to-fts5`).

### Modified Capabilities

- None (no spec'd capability changes shape: the `SqliteStorage` interface, tool
  surface, and backup format are unchanged).

## Impact

- Affected code: `src/storage/sqlite.ts` (engine internals, ~80 `prepare`/`run`
  sites), `src/backup/index.ts` (restore activation ordering), `src/types.d.ts`,
  `package.json`, test files importing `sql.js` directly
  (`src/bootstrap/session.test.ts:2`, `src/tools/bootstrap.test.ts:2`), FTS5
  canary/health tests.
- Behavior: identical query semantics (same SQL dialect, same schema, same
  `SqliteStorage` contract); better durability (commit-level instead of
  5-second-deferred whole-file flush); `brain.db` on-disk format remains a standard
  SQLite 3 file, readable by the old code after a WAL checkpoint on close.
- Docs: `README.md` names `sql.js` in the architecture diagram (line 77) and storage
  description (line 113) — those lines change in all five READMEs; version bump.
  Node-floor doc edits stay with `refresh-dependency-and-node-baseline`.
- Depends on: `refresh-dependency-and-node-baseline` (Node >=22 engines/docs).
  Unblocks: `upgrade-fulltext-to-fts5` (11 remaining tasks). Supersedes:
  `coalesce-and-fsync-sqlite-flushes`.
