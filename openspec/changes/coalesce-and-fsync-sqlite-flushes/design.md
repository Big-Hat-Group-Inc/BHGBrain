## Context

sql.js holds the whole database in WASM memory; persistence is `db.export()` → one
buffer → `atomicWriteFileSync` (`src/storage/sqlite.ts:422-426`). There is no WAL, no
page-level write, no incremental checkpoint — every flush is O(total DB size). The
codebase already contains both halves of the right policy, just wired to the wrong
paths:

- Inline `flushIfDirty()` guards every mutation (17 sites in `src/storage/index.ts`,
  8 in `src/tools/index.ts`), so a `remember` pays two full-image rewrites
  (`writeMemory` at `src/storage/index.ts:153`, then the pipeline's `logAudit` at
  `src/storage/index.ts:759`).
- `scheduleDeferredFlush()` (`src/storage/sqlite.ts:436-443`) coalesces flushes behind
  a 5 s timer, respects the lifecycle-operation guard, and is already cancelled +
  drained by `close()` (`src/storage/sqlite.ts:1560-1563`) and by
  `beginLifecycleOperation` (which cancels the timer before restore/reconcile). But
  only read-path bookkeeping uses it (`src/search/index.ts:388`,
  `src/resources/index.ts:89`, bootstrap-session rows at
  `src/storage/sqlite.ts:1714/1742/1783`).

Meanwhile the durability foundation is missing: `atomicWriteFileSync`
(`src/storage/sqlite.ts:1883-1887`) never calls fsync, so the atomic-rename pattern
protects against a crash *mid-write* but not against a crash shortly *after* — data
blocks may still be in the page cache when the rename metadata commits, and the
"atomic" replacement can materialize as a truncated file. Since `brain.db` is the only
durable copy (Qdrant holds vectors, not metadata), that is total loss.

`init()` (`src/storage/sqlite.ts:359-373`) always ends in `this.flush()`, and
`ensureMemoryColumns` (`src/storage/sqlite.ts:1798-1833`) applies `ALTER TABLE`s
without reporting whether it did anything, so a clean boot of a current-schema store
still rewrites the entire file. `BackupService.create` (`src/backup/index.ts:53-97`)
does `Buffer.concat([headerLen, headerBuf, dbData])` — a second full-size allocation —
and a synchronous write; `restore` (`src/backup/index.ts:108-119`) starts with
`readFileSync`.

## Goals / Non-Goals

Goals:
- Every persisted image of `brain.db` is crash-durable (fsync before and, where the
  platform allows, after the rename).
- One coalesced flush per burst of writes instead of ≥2 full-image rewrites per
  mutation, with a hard bound on both the time window (existing 5 s) and the number of
  dirty mutations that can await a single flush.
- Boot of an unchanged store does not rewrite the database file.
- Backup create/restore neither blocks the event loop on full-DB-size I/O nor
  allocates a second full-size contiguous buffer.
- Byte-identical `.bhgb` format and unchanged MCP/tool semantics.

Non-Goals:
- Replacing sql.js with a native engine (better-sqlite3 / node:sqlite WAL). That is
  `migrate-sqlite-to-native-engine` territory; see Decisions and Risks.
- Making tool responses wait for durable persistence (that would *keep* the inline
  flush; the point is a deliberate, bounded window).
- Changing the deferred window used by read-path bookkeeping (stays 5 s).
- Streaming/chunked `db.export()` — sql.js only exports whole images.

## Decisions

- **Deferred flush is the default; inline flush is a barrier.** Success paths of
  `writeMemory` / `updateMemory` (`src/storage/index.ts:153,235`), `deleteMemory`, and
  `logAudit` (`src/storage/index.ts:759`) call `scheduleDeferredFlush()`. Inline
  `flushIfDirty()` is reserved for: degraded writes where SQLite is the only copy
  (`writeMemoryWithoutVector`, `src/storage/index.ts:163`; vector-sync-failure marks
  at `src/storage/index.ts:149,230`), rollback/consistency repairs (archive rollback
  at `src/tools/index.ts:376`), lifecycle batch endpoints (reconcile / re-embed /
  `bootstrapFromQdrant` / retention sweeps, which already flush once per batch),
  backup create/restore, and `close()`. Rationale: the degraded/rollback paths are
  precisely where an ill-timed crash converts a recoverable state into an
  inconsistent one; everywhere else the audit row and memory row commit or vanish
  together inside one coalesced image, which is strictly more consistent than today's
  flush-between-them behavior.
- **The `flush` options invert to match the new default.** Today
  `deleteMemory(options.flush !== false)` flushes inline (`src/storage/index.ts:295-299`)
  and `RetentionService` passes `flush: false` then flushes per batch. New semantics:
  default defers; `flush: true` forces the inline barrier. Same treatment for
  `logAudit`'s `options.flush` (`src/storage/index.ts:741-761`): default schedules,
  `flush: true` is the barrier. All callers audited in the tasks.
- **Bounded dirty window by count, not just time.** `scheduleDeferredFlush` keeps its
  early-return-if-timer-pending shape (so the window stays ≤5 s from the *first*
  deferred mutation, not sliding), and additionally tracks mutations-since-last-flush;
  at ≥64 it flushes inline and resets. Sixty-four full-image rewrites saved per window
  is already the whole win; beyond that the marginal latency benefit does not justify
  a larger loss window. The counter lives next to `markDirty` and resets in `flush()`.
- **fsync placement.** `atomicWriteFileSync` becomes: open temp → write → fsync →
  close → rename → on `process.platform !== 'win32'`, open the parent directory and
  fsync it, wrapped in try/catch (some filesystems reject directory fsync; Windows
  rejects opening directories, and NTFS metadata journaling covers the rename). The
  temp file is removed on failure. The async `atomicWriteFile(path, buffers)` mirrors
  this with fs/promises and writes the buffers sequentially through one `FileHandle`
  — which is what lets backup drop `Buffer.concat`.
- **Startup no-op detection via `PRAGMA schema_version`.** `ensureMemoryColumns`
  returns `boolean` (any `ALTER TABLE` executed), but the robust signal is comparing
  `PRAGMA schema_version` before and after `ensureMemoryColumns()` + `SCHEMA_SQL` —
  it increments on any DDL, including a future `CREATE TABLE IF NOT EXISTS` that
  actually fires. `init()` marks dirty when the DB file did not exist or
  schema_version moved, then ends with `flushIfDirty()`. Accepted quirk: the FTS5
  probe operates in the `temp` schema (`probeFts5Support`) and does not perturb the
  main schema_version.
- **Backup I/O goes async, format unchanged.** `create()` computes the checksum over
  `dbData` exactly as today, then awaits the async atomic write of
  `[headerLen, headerBuf, dbData]`; `size_bytes` is computed arithmetically as
  `4 + headerBuf.length + dbData.length`. `restore()` uses fs/promises `readFile` and
  writes the restored DB with the async atomic write. The lifecycle guard
  (`beginRestoreOperation`) already serializes restore against mutations, so awaiting
  inside it is safe.
- **Graceful supersession.** If `migrate-sqlite-to-native-engine` (sibling proposal,
  authored in parallel) lands, a native WAL engine makes the whole flush/defer/export
  dance obsolete — this change's flush-policy edits collapse into no-op shims and the
  fsync'd atomic writer remains useful mainly for backups. That is fine: this change
  is deliberately small, touches the same call sites the migration must visit anyway,
  and fixes an active data-loss hazard *now* rather than after a much larger migration
  stabilizes. Ship this first.

## Risks / Trade-offs

- **Process-crash window on writes widens from ~0 s to ≤5 s / ≤64 mutations.** But
  today's ~0 s window is illusory: without fsync, an OS crash or power loss can lose
  not just recent writes but the *entire* file. Trading a bounded, documented
  process-crash window for actual power-loss durability strictly improves the
  worst case. Graceful shutdown still drains via `close()`
  (`src/storage/sqlite.ts:1560-1563`).
- **fsync makes each flush slower.** Offset many times over by issuing far fewer
  flushes, and the deferred timer moves most of them off the request path entirely.
- **Qdrant/SQLite divergence on crash.** A crash losing the last ≤5 s of SQLite rows
  can leave orphan vectors in Qdrant. This is already the system's recoverable
  direction: reconciliation (`reconcileVectorsFromSqlite`) and the `repair` tool
  handle vector/metadata drift, and the pre-existing deferred read-path writes
  accepted the same trade.
- **Test churn.** Mocks that enumerate `SqliteStorage` methods must gain
  `scheduleDeferredFlush`, and flush-count assertions
  (`src/storage/index.test.ts:419,593`, `src/backup/retention.test.ts:133,200`) need
  re-pointing at the new policy — mechanical but broad.
- **Windows directory-fsync gap.** Parent-dir fsync is skipped on win32 (unsupported
  at the fs API level); rename durability there rests on NTFS journaling, which is
  the accepted platform norm.
