## Context

sql.js keeps the whole database in wasm memory and persists by exporting the full
image (`flush()`, `src/storage/sqlite.ts:422-426`), so there are two distinct costs to
manage: per-query CPU inside the wasm engine (plans, statement compilation,
transaction bookkeeping) and image size (every byte in any table is re-serialized on
every flush and re-parsed at startup). This change attacks both without altering any
query's result set.

The relevant mechanics, verified against current code:

- `SCHEMA_SQL` (indexes at `src/storage/sqlite.ts:203-214`) is executed with
  `IF NOT EXISTS` on every `init()` (`:370`) and `reloadFromDisk()` (`:388`), which is
  also the existing migration mechanism for new indexes (see the comment at `:367`).
- `deleteMemory` (`:615-623`) probes `getMemoryById` then issues two DELETEs;
  `StorageManager.deleteMemories` calls it in a loop (`src/storage/index.ts:337-343`)
  after Qdrant vectors are confirmed removed per group.
- `upsertMemoryFromPayload` (`:504-576`) is idempotency-guarded by a per-point
  `getMemoryById` probe (`:541-543`) and wrapped in its own `BEGIN`/`COMMIT` (`:551`)
  so the `memories` + `memories_fts` pair stays atomic; `bootstrapFromQdrant`
  (`src/storage/index.ts:428-455`) explicitly requires that one bad point not abort
  the rest of its collection.
- `HealthService` already has a cache precedent: embedding health is cached for 30s
  (`src/health/index.ts:12-14`). `check()` (`:24-61`) invokes `checkRetention()`
  (`:163`) and `checkVectorReconciliation()` (`:179`) and *also* computes
  `countByTier` (`:34`) and `countUnsyncedVectors` (`:55`) for the retention block —
  each aggregate runs twice per poll. `/health` skips auth
  (`src/transport/middleware.ts:30`) and rate limiting today.
- `RetentionService.runGc` (`src/backup/retention.ts:50`) is the single scheduled
  maintenance entry point (CLI `gc` and `CleanupScheduler`, `src/backup/scheduler.ts:144`
  share it); its success bookkeeping lands at `src/backup/retention.ts:170-178`.

## Goals / Non-Goals

Goals:
- Index every hot list/sweep predicate so `EXPLAIN QUERY PLAN` shows index search
  with no `USE TEMP B-TREE FOR ORDER BY` on the paginated lists.
- One transaction per logical batch (delete batch, hydration collection), not per row.
- Prepare fixed-SQL statements once per database handle.
- Bound `audit_log` and `memory_revisions` growth via the existing GC run.
- At most one execution of each SQLite aggregate per health snapshot, with a short-TTL
  cache absorbing rapid unauthenticated polls.
- Zero change to any query's result set or to write-path atomicity guarantees.

Non-Goals:
- No access control or rate limiting for `/health` — that is
  `harden-http-health-rate-limit-and-resource-bounds`.
- No FTS5/BM25 work (`upgrade-fulltext-to-fts5`) and no change to the `LIKE`-based
  matcher's semantics.
- No incremental/WAL persistence — full-image flush stays; we only shrink the image.
- No pruning of `memory_archive` (it has its own lifecycle and restore semantics).

## Decisions

- **Index set**: add
  `idx_memories_ns_created(namespace, created_at DESC, id DESC)`,
  `idx_memories_ns_coll_created(namespace, collection, created_at DESC, id DESC)`,
  `idx_memories_stale_accessed(stale, last_accessed)`,
  `idx_memories_unsynced_created(vector_synced, created_at, id)`; drop
  `idx_memories_namespace` and `idx_memories_collection`, whose leftmost prefixes the
  first two subsume. Net: +4/−2 indexes, keeping write amplification roughly flat.
  Migration is free because `SCHEMA_SQL` re-runs on every init; the drops need an
  explicit `DROP INDEX IF EXISTS` in the same script.
- **Chunked IN-list delete**: new `deleteMemoriesByIds(ids)` deletes from `memories`
  and `memories_fts` with `WHERE id IN (...)` in chunks of 500 (comfortably under any
  SQLite bound-parameter limit), all chunks inside one `BEGIN`/`COMMIT`, returning the
  count via `db.getRowsModified()`. No per-row existence probe — the caller already
  holds the confirmed-id set, and DELETE of a missing id is a harmless no-op counted
  as zero. `StorageManager.deleteMemories` keeps its confirmed-set logic and swaps the
  loop for one call.
- **Hydration batching**: preserve `upsertMemoryFromPayload`'s per-point atomicity by
  moving from per-point transactions to per-collection `BEGIN`/`COMMIT` with a
  `SAVEPOINT`/`RELEASE` (or `ROLLBACK TO`) per point — a failed point rolls back only
  itself, exactly matching today's best-effort contract. The per-point
  `getMemoryById` probe is replaced by a `Set` of existing ids preloaded once per
  bootstrap (new cheap `listMemoryIds()`), with the outer transaction still catching
  genuine constraint violations loudly.
- **Statement cache**: a `Map<string, Statement>` keyed by exact SQL text, used only
  for fixed-SQL call sites (dynamically assembled SQL — cursor variants, filters —
  keeps the prepare-per-call path). Reuse is `reset()` + `bind()` + step. The cache is
  freed in `close()` (`:1560-1564`) and cleared in `reloadFromDisk()` (`:375-391`)
  because both replace `this.db`, and a Statement outliving its Database handle is a
  wasm memory leak / crash. No size bound needed: the key space is the fixed set of
  SQL literals in the file.
- **Pruning in GC, not on the write path**: `pruneAuditLog(max)` keeps the newest
  `max` rows by `timestamp` (served by the existing `idx_audit_timestamp`, `:252`);
  `pruneRevisions(maxPerMemory)` keeps the highest `revision` numbers per `memory_id`.
  Both are invoked from `runGc`'s destructive phase before the flush at
  `src/backup/retention.ts:170`, so pruning inherits GC's lifecycle bracketing,
  scheduling, dry-run exclusion, and degraded-state reporting — no new scheduler.
- **Cap configuration**: `retention.audit_log_max_entries` (default `50000`) and
  `retention.revisions_per_memory_max` (default `20`), both `nullable` with `null`
  meaning "never prune" — the current behavior — added to the existing retention block
  (`src/config/index.ts:121-145`). Defaults are generous enough that a store must be
  genuinely long-lived before any row is dropped.
- **Health single-pass + TTL cache**: `check()` computes `countByTier` and
  `countUnsyncedVectors` once and passes them as parameters into
  `checkRetention(counts)` and `checkVectorReconciliation(unsynced)`. The SQLite
  stats block (`memory_count`, `db_size_bytes`, tier counts, expiring/archived/
  unsynced counts) is additionally cached for 5s following the
  `cachedEmbeddingHealth` pattern — long enough to absorb poll storms on the
  unauthenticated endpoint, short enough that operators still see near-live numbers.
  Status *components* (degraded flags, lifecycle state) are not cached.
- **`generateSummary`**: `indexOf('\n')` + `substring` replaces `split('\n')[0]` —
  same output for every input (content is already `\r\n`-normalized upstream by
  `normalizeContent`), no array allocation proportional to content size.

## Risks / Trade-offs

- **Pruning deletes history that was previously permanent.** Mitigated by generous
  defaults, `null` opt-out, README documentation, and running only inside GC (dry-run
  GC reports without deleting). Audit rows are operational telemetry, not memories —
  memory content is untouched.
- **Index changes shift write costs.** Four new indexes tax inserts/updates; dropping
  the two subsumed ones claws most of it back. `EXPLAIN QUERY PLAN` tests pin the
  intended plans so a future sql.js upgrade that changes the planner is caught.
- **SAVEPOINT semantics under sql.js** must be verified in tests (nested savepoint
  inside explicit transaction, rollback-to leaving the outer transaction usable);
  if the wasm build misbehaves, the fallback is per-point transactions retained but
  the id-`Set` probe optimization kept — still removing one query per point.
- **Statement-cache lifetime bugs** (use-after-free on reload) are the classic sql.js
  hazard; addressed by clearing the cache at both handle-replacement sites and a
  regression test that reloads then queries.
- **A 5s-stale health stats block** can briefly under/over-report counts after a big
  write. Component *statuses* stay live, and 5s is far inside any monitoring poll
  interval; the TTL is a named constant should it need tuning.
- **Concurrent-build hazard**: this change and
  `harden-http-health-rate-limit-and-resource-bounds` both touch `src/health/` and
  `src/transport/`-adjacent expectations; build sequentially (which the
  `/build-proposals` workflow already enforces).
