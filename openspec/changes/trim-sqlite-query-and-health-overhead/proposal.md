## Why

The SQLite layer pays avoidable overhead on its hottest paths, and two insert-only
tables grow forever:

- **List/sweep predicates have no covering index.** `listMemories` and
  `listMemoriesInCollection` order by `created_at DESC, id DESC`
  (`src/storage/sqlite.ts:662-702`) but the schema only provides
  `idx_memories_namespace` / `idx_memories_collection` (`src/storage/sqlite.ts:203-204`)
  — SQLite must sort every page with a temp B-tree. `listStaleCandidateIds` filters on
  `last_accessed < ?` (`src/storage/sqlite.ts:824-836`) with no index on
  `last_accessed` at all (the existing `idx_memories_stale` is `(stale, importance)`),
  so every staleness sweep is a full table scan. `listMemoriesNeedingVectorSync`
  (`src/storage/sqlite.ts:1104-1122`) orders by `created_at ASC, id ASC` but
  `idx_memories_vector_synced` covers only the flag column.
- **Batch operations run statement-at-a-time.** `StorageManager.deleteMemories` loops
  `deleteMemory` per row (`src/storage/index.ts:337-343`), and each `deleteMemory` call
  performs its own `getMemoryById` existence probe plus two single-row DELETEs
  (`src/storage/sqlite.ts:615-623`). `bootstrapFromQdrant` hydrates point-by-point
  (`src/storage/index.ts:428-455`), and each `upsertMemoryFromPayload` runs a
  `getMemoryById` probe and its own `BEGIN`/`COMMIT` (`src/storage/sqlite.ts:541-576`)
  — thousands of tiny transactions on a cold-start hydration.
- **Every query re-prepares its SQL.** All 38 `this.db.prepare(...)` call sites in
  `src/storage/sqlite.ts` compile the statement, run it once, and free it — including
  fixed-SQL hot paths like `getMemoryById` that run on every recall hydration.
- **`audit_log` and `memory_revisions` are insert-only forever.** Inserts exist
  (`src/storage/sqlite.ts:1490`, `:1310`) but no `DELETE FROM audit_log` or
  `DELETE FROM memory_revisions` appears anywhere in `src/`. Because sql.js persists by
  exporting the full database image (`flush()`, `src/storage/sqlite.ts:422-426`) and
  loads it whole at startup (`src/storage/sqlite.ts:360-372`), unbounded history
  inflates every flush and every startup, not just those tables' own queries.
- **`/health` computes the same stats twice per poll.** `HealthService.check()` calls
  `countByTier` at `src/health/index.ts:34` and again inside `checkRetention`
  (`src/health/index.ts:172`), and `countUnsyncedVectors` at `src/health/index.ts:55`
  and again inside `checkVectorReconciliation` (`src/health/index.ts:180`) — on an
  endpoint that bypasses auth (`src/transport/middleware.ts:30`), so unauthenticated
  polling drives duplicated full-table aggregate scans.
- **`generateSummary` allocates an array of every line** just to read the first one
  (`content.split('\n')[0]`, `src/domain/normalize.ts:16`) — on every remember of
  arbitrarily large content.

## What Changes

- Append composite indexes to `SCHEMA_SQL`: `(namespace, created_at DESC, id DESC)`,
  `(namespace, collection, created_at DESC, id DESC)`, `(stale, last_accessed)`, and
  `(vector_synced, created_at, id)`; drop the two single-column-prefix indexes they
  subsume. `CREATE INDEX IF NOT EXISTS` in `SCHEMA_SQL` runs on every init/reload
  (`src/storage/sqlite.ts:370`, `:388`), so existing databases migrate automatically.
  Guard the plans with `EXPLAIN QUERY PLAN` tests.
- Batch the write paths: a chunked `IN`-list `deleteMemoriesByIds` (one transaction,
  no per-row existence probe) behind `StorageManager.deleteMemories`, and
  per-collection `BEGIN`/`COMMIT` with per-point `SAVEPOINT`s plus a preloaded
  existing-id `Set` for `bootstrapFromQdrant` hydration.
- Add a small Map-based prepared-statement cache for fixed-SQL queries, freed on
  `close()` and invalidated on `reloadFromDisk()` (both replace the `db` handle).
- Add `pruneAuditLog` / `pruneRevisions`, invoked from the existing
  `RetentionService.runGc` cleanup with configurable caps
  (`retention.audit_log_max_entries`, `retention.revisions_per_memory_max`).
- Compute `countByTier` / `countUnsyncedVectors` once per health poll and pass them
  into `checkRetention` / `checkVectorReconciliation`; add a short-TTL cache for the
  SQLite stats block, mirroring the existing embedding-health cache pattern
  (`src/health/index.ts:12-14`).
- Replace `generateSummary`'s full `split('\n')` with an `indexOf`/`substring`.
- Document the new retention caps in `README.md` + the four translations; bump
  `package.json` version.

## Capabilities

### New Capabilities
- `sqlite-query-efficiency`: Hot-path SQLite queries use covering indexes, batch
  operations run in bounded transactions, fixed statements are prepared once, and
  health polls compute each aggregate at most once per snapshot.
- `history-table-pruning`: `audit_log` and `memory_revisions` are bounded by
  configurable caps enforced during the existing scheduled cleanup.

### Modified Capabilities

## Impact

- Affected code: `src/storage/sqlite.ts` (schema, batch helpers, statement cache,
  prune methods), `src/storage/index.ts` (`deleteMemories`, `bootstrapFromQdrant`),
  `src/backup/retention.ts` (`runGc` prune hook), `src/health/index.ts` (single-pass
  stats + TTL cache), `src/domain/normalize.ts` (`generateSummary`),
  `src/config/index.ts` (retention caps), co-located tests.
- Behavior: identical query *results*; faster plans, fewer transactions, bounded
  history growth, cheaper health polls. Pruning is the one observable change: audit
  entries beyond the cap and revisions beyond the per-memory cap are deleted by GC
  (both caps configurable, `null` disables).
- Docs: README ×5 (new retention config keys), version bump. No new env vars, so
  `.env.example` is unchanged.
- Relationship: complements `harden-http-health-rate-limit-and-resource-bounds` —
  that change gates *access* to `/health` (auth policy, rate limits); this one bounds
  the *cost per poll*. No file-level conflict in what each edits, but they touch
  adjacent code in `src/health/` and should not be built concurrently.
