## 1. Fsync durability in atomic writes

- [ ] 1.1 Rework `atomicWriteFileSync` (`src/storage/sqlite.ts:1883-1887`): open the
  temp file, write, `fsyncSync`, close, `renameSync`; then on
  `process.platform !== 'win32'` open the parent directory and fsync it inside a
  try/catch (directory fsync is unsupported on Windows and on some filesystems).
  Remove the temp file if any step before the rename throws.
- [ ] 1.2 Add an async counterpart `atomicWriteFile(targetPath, buffers: Buffer[])`
  (fs/promises `FileHandle`, sequential writes, same fsync + rename + dir-fsync
  semantics), exported from `src/storage/sqlite.ts` beside the sync version, for use
  by `src/backup/index.ts`.
- [ ] 1.3 Tests for both writers: target file has the exact concatenated content, no
  `.tmp` file remains after success or failure, and the dir-fsync branch is skipped
  on win32 without throwing.

## 2. Deferred flush as the write-path default

- [ ] 2.1 Add the bounded dirty window to `SqliteStore`
  (`src/storage/sqlite.ts:436-443`): count mutations in `markDirty`
  (`src/storage/sqlite.ts:428-430`), reset the count in `flush()`
  (`src/storage/sqlite.ts:422-426`), and make `scheduleDeferredFlush` flush inline
  once the count since the last flush reaches 64 (respecting the existing
  `lifecycleOperation` guard).
- [ ] 2.2 `StorageManager.writeMemory` / `updateMemory`: replace the success-path
  `flushIfDirty()` (`src/storage/index.ts:153` and `src/storage/index.ts:235`) with
  `scheduleDeferredFlush()`. Keep the inline flushes on the vector-sync-failure paths
  (`src/storage/index.ts:149` and `src/storage/index.ts:230`) and in
  `writeMemoryWithoutVector` (`src/storage/index.ts:163`).
- [ ] 2.3 `StorageManager.deleteMemory` (`src/storage/index.ts:287-300`) and
  `deleteMemories` (`src/storage/index.ts:302-349`, flush at 345-347): invert the
  option — default defers via `scheduleDeferredFlush()`, `options.flush: true` forces
  inline. Update the `RetentionService` call sites in `src/backup/retention.ts`
  (which pass `flush: false` at `src/backup/retention.ts:119,145,158` and flush per
  batch at `src/backup/retention.ts:170,217,300,393`) to drop the now-default option
  while keeping their per-batch inline barriers.
- [ ] 2.4 `StorageManager.logAudit` (`src/storage/index.ts:741-761`): default becomes
  `scheduleDeferredFlush()`; `options.flush: true` is the inline barrier. Audit every
  caller (`src/pipeline/index.ts:185,207,238,280,407`, `src/tools/index.ts:217,342,
  380,442,495`, `src/storage/index.ts:198,270`) — none of them needs the barrier.
- [ ] 2.5 Tool handlers doing direct metadata mutations swap `flushIfDirty()` for
  `scheduleDeferredFlush()`: tag update (`src/tools/index.ts:260`), review keep
  (`src/tools/index.ts:340`), collection create (`src/tools/index.ts:474`), category
  set/delete (`src/tools/index.ts:532,540`). Keep inline flushes at the archive
  rollback (`src/tools/index.ts:376`), forced collection delete
  (`src/tools/index.ts:501`), and repair recovery (`src/tools/index.ts:681`) —
  rollback/batch barriers per design.
- [ ] 2.6 Document the policy in code: a comment block on
  `flushIfDirty`/`scheduleDeferredFlush` in `src/storage/sqlite.ts` naming the rule
  (deferred by default on write paths; inline only for close/backup/restore/degraded/
  rollback/lifecycle barriers) so future call sites pick the right one.
- [ ] 2.7 Tests: with fake timers, a burst of writes produces one flush after the
  timer fires; the 64-mutation cap forces an inline flush mid-burst; `close()`
  (`src/storage/sqlite.ts:1560-1563`) still drains a pending deferred flush. Update
  mocks missing `scheduleDeferredFlush` (e.g. `src/storage/index.test.ts:67`,
  `src/tools/index.test.ts:32,253,431`, `src/backup/retention.test.ts`) and the
  flush-count assertions at `src/storage/index.test.ts:419,593` and
  `src/backup/retention.test.ts:133,200` to the new policy.

## 3. Eliminate the no-op startup rewrite

- [ ] 3.1 Make `ensureMemoryColumns` (`src/storage/sqlite.ts:1798-1833`) return
  `boolean` — whether any `ALTER TABLE` ran.
- [ ] 3.2 In `init()` (`src/storage/sqlite.ts:359-373`): record whether the DB file
  existed, read `PRAGMA schema_version` before and after
  `ensureMemoryColumns()` + `SCHEMA_SQL`, mark dirty when the file was fresh or the
  schema_version moved (or 3.1 reported a migration), and replace the unconditional
  `this.flush()` (`src/storage/sqlite.ts:372`) with `this.flushIfDirty()`.
- [ ] 3.3 Tests: re-initializing an existing current-schema DB leaves the file bytes
  untouched (compare content or mtime); a fresh data dir still creates `brain.db`;
  a DB missing a migrated column (e.g. `embedding_model`) still persists the
  migration at init.

## 4. Async backup I/O

- [ ] 4.1 `BackupService.create` (`src/backup/index.ts:53-97`): drop
  `Buffer.concat` (`src/backup/index.ts:79`) and the `atomicWriteFileSync` call
  (`src/backup/index.ts:80`); write `[headerLen, headerBuf, dbData]` via the async
  `atomicWriteFile` from task 1.2 and compute `size_bytes` as
  `4 + headerBuf.length + dbData.length`. Checksum stays over `dbData` only.
- [ ] 4.2 `BackupService.restore` (`src/backup/index.ts:108-119`): replace
  `readFileSync` (`src/backup/index.ts:118`) with fs/promises `readFile` and write
  the restored DB (`src/backup/index.ts:133` area, `atomicWriteFileSync` on
  `dbPath`) via the async writer. Update the module imports
  (`src/backup/index.ts:2,6`) accordingly.
- [ ] 4.3 Tests: create → restore round-trip produces the same archive bytes/header
  layout as before the change (format regression test) and the checksum-mismatch
  rejection path still fires.

## 5. Validation

- [ ] 5.1 `npm run lint` passes (tsc + eslint, no `any` casts introduced).
- [ ] 5.2 `npm test` passes.
- [ ] 5.3 Confirm no user-facing surface changed: no MCP tool/resource schema, config
  key, env var, or `.bhgb` format change — therefore no `README.md`/translation
  edits and no `package.json` version bump (per CLAUDE.md these apply to
  user-visible changes only). Re-verify this holds at implementation time.
