## Why

Persistence today has the trade-offs exactly backwards: it pays a full-database-image
rewrite on every mutation, yet the one write that must never be lost is not durable.

- **Every mutating path flushes the full DB image inline.** `flush()` serializes the
  entire sql.js database (`db.export()`) and rewrites `brain.db` from scratch
  (`src/storage/sqlite.ts:422-426`). There are 17 `flushIfDirty()` call sites in
  `src/storage/index.ts` and 8 more in `src/tools/index.ts`, all synchronous on the
  request path. A single `remember` triggers at least two full-image rewrites: one at
  the end of `StorageManager.writeMemory` (`src/storage/index.ts:153`) and another
  from the `logAudit('ADD', ...)` that immediately follows it
  (`src/pipeline/index.ts:238`, flushing at `src/storage/index.ts:759`). As the store
  grows, every write gets slower in proportion to *total* database size, twice over.
- **The existing deferred-flush machinery is only used on read paths.**
  `scheduleDeferredFlush()` (`src/storage/sqlite.ts:436-443`, 5 s timer) was added for
  access-tracking writes (`src/search/index.ts:388`, `src/resources/index.ts:89`,
  bootstrap-session rows at `src/storage/sqlite.ts:1714/1742/1783`) — the paths where
  losing 5 s of data is *most* consequential still flush inline, and the paths where
  it is least consequential already defer.
- **None of it is actually durable.** `atomicWriteFileSync`
  (`src/storage/sqlite.ts:1883-1887`) is `writeFileSync` + `renameSync` with **no
  fsync** of the temp file or its directory. On power loss or OS crash, the rename can
  be journaled while the data blocks are not, leaving `brain.db` — the *only* durable
  copy of all metadata — truncated or zero-filled. That is total metadata loss, not a
  5-second window. The inline-flush-everywhere policy buys nothing against the failure
  mode it appears to defend against.
- **Startup rewrites the file even when nothing changed.** `init()` ends with an
  unconditional `this.flush()` (`src/storage/sqlite.ts:372`), rewriting the whole
  database on every boot of an already-migrated store.
- **Backup I/O blocks the event loop at full DB size.** `BackupService.create` builds
  a second full-size copy via `Buffer.concat` and writes it synchronously
  (`src/backup/index.ts:79-80`); `restore` reads the archive with `readFileSync`
  (`src/backup/index.ts:118`). During these, the HTTP transport serves nothing.

## What Changes

- **fsync in atomic writes**: `atomicWriteFileSync` fsyncs the temp file before the
  rename, and fsyncs the parent directory after it on non-Windows platforms. Add an
  async counterpart (`atomicWriteFile`, fs/promises `FileHandle`) with the same
  durability semantics that accepts a sequence of buffers, for backup I/O.
- **Deferred flush becomes the default write-path persistence policy**:
  `StorageManager.writeMemory` / `updateMemory` / `deleteMemory` success paths and
  `logAudit` schedule the existing deferred flush instead of flushing inline; tool
  handlers doing direct metadata mutations do the same. Inline flush remains the rule
  for barriers: `close()`, backup create/restore, degraded writes
  (`writeMemoryWithoutVector`, vector-sync-failure paths), rollback paths, and
  lifecycle batch operations (reconcile, re-embed, retention sweeps).
- **Bounded max-dirty window**: `scheduleDeferredFlush` gains a dirty-mutation
  counter; once the count since the last flush reaches a cap it flushes inline instead
  of deferring, so a sustained write burst can never accumulate an unbounded number of
  unflushed mutations behind one 5 s timer.
- **No-op startup rewrite eliminated**: `init()` detects whether anything actually
  changed (fresh database file, or DDL applied by `ensureMemoryColumns` / `SCHEMA_SQL`
  as observed via `PRAGMA schema_version`) and ends with `flushIfDirty()` instead of
  an unconditional `flush()`.
- **Async backup I/O**: `BackupService.create` streams `[headerLen, headerBuf,
  dbData]` sequentially through a `FileHandle` (no full-size `Buffer.concat`);
  `restore` reads the archive and writes the restored database with fs/promises. The
  on-disk `.bhgb` format is byte-identical to today's.

## Capabilities

### New Capabilities
- `sqlite-flush-durability`: SQLite persistence coalesces write-path flushes through
  the deferred-flush scheduler with a bounded dirty window, makes every flush
  crash-durable via fsync, skips the no-op full-file rewrite at startup, and performs
  backup I/O asynchronously.

### Modified Capabilities

## Impact

- Affected code: `src/storage/sqlite.ts` (`atomicWriteFileSync`, new async variant,
  `scheduleDeferredFlush`, `init`, `ensureMemoryColumns`), `src/storage/index.ts`
  (flush call sites in `writeMemory` / `updateMemory` / `deleteMemory` / `logAudit`),
  `src/tools/index.ts` (direct-mutation handlers), `src/backup/index.ts`
  (`create` / `restore`), co-located tests (including flush-count assertions in
  `src/storage/index.test.ts:419,593` and mock shapes that omit
  `scheduleDeferredFlush`).
- Behavior: crash durability strictly improves (fsync closes the truncation window);
  process-crash exposure on the hot write path moves from ~0 s to at most 5 s / N
  mutations — the same exposure already accepted for access tracking, now applied
  where the win is largest. MCP tool responses still return only after SQLite has the
  row in memory; only the file write is coalesced.
- Docs: none — internal persistence policy; no MCP surface, config, or env change. No
  README/translation edits, no version bump.
- Relationship: superseded gracefully by `migrate-sqlite-to-native-engine` (sibling
  proposal, authored in parallel) if that lands — see design.md. Small enough to ship
  first and de-risk the interim.
