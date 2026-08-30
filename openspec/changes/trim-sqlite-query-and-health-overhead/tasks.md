## 1. Composite indexes

- [x] 1.1 Append to `SCHEMA_SQL` (`src/storage/sqlite.ts:203-214`):
  `idx_memories_ns_created(namespace, created_at DESC, id DESC)`,
  `idx_memories_ns_coll_created(namespace, collection, created_at DESC, id DESC)`,
  `idx_memories_stale_accessed(stale, last_accessed)`,
  `idx_memories_unsynced_created(vector_synced, created_at, id)`; add
  `DROP INDEX IF EXISTS idx_memories_namespace` and
  `DROP INDEX IF EXISTS idx_memories_collection` (subsumed prefixes). Existing DBs
  migrate automatically because `SCHEMA_SQL` runs on every `init()`
  (`src/storage/sqlite.ts:370`) and `reloadFromDisk()` (`src/storage/sqlite.ts:388`).
- [x] 1.2 Add `EXPLAIN QUERY PLAN` tests in `src/storage/sqlite.test.ts` asserting
  `listMemories` (`src/storage/sqlite.ts:662-681`), `listMemoriesInCollection`
  (`:682-702`), `listStaleCandidateIds` (`:824-836`), and
  `listMemoriesNeedingVectorSync` (`:1104-1122`) all report a `SEARCH ... USING
  INDEX idx_memories_...` step, and that the two paginated lists show no
  `USE TEMP B-TREE FOR ORDER BY`.
- [x] 1.3 Migration test: open a DB image created with the old schema (build it in
  the test via the old index DDL), run `init()`, verify the new indexes exist and the
  dropped ones are gone (`SELECT name FROM sqlite_master WHERE type='index'`).

## 2. Batched deletes and hydration transactions

- [x] 2.1 Add `deleteMemoriesByIds(ids: string[]): number` to `SqliteStorage`
  (interface `src/storage/sqlite.ts:79` area): chunked `WHERE id IN (...)` DELETEs
  (chunk size 500) against `memories` and `memories_fts`, all chunks inside one
  `BEGIN`/`COMMIT`, no per-row `getMemoryById` probe, count from
  `db.getRowsModified()`; `assertMutableAllowed()` + `markDirty()` like the existing
  single-row `deleteMemory` (`src/storage/sqlite.ts:615-623`).
- [x] 2.2 Replace the per-row loop in `StorageManager.deleteMemories`
  (`src/storage/index.ts:337-343`) with one `deleteMemoriesByIds` call over the
  confirmed ids; keep the confirmed/unreconciled grouping and the returned `deleted`
  count semantics intact.
- [x] 2.3 Add `listMemoryIds(): Set<string>` (or reuse the shape of
  `listMemoryChecksums`) to `SqliteStorage`, and in `bootstrapFromQdrant`
  (`src/storage/index.ts:428-455`) preload it once, skipping already-present points
  without a per-point `getMemoryById` query.
- [x] 2.4 Convert hydration to per-collection `BEGIN`/`COMMIT` with a per-point
  `SAVEPOINT`/`RELEASE` (`ROLLBACK TO` on error) so `upsertMemoryFromPayload`
  (`src/storage/sqlite.ts:504-576`) keeps its per-point atomicity (`memories` +
  `memories_fts` together) and one bad point still cannot abort the rest of the
  collection; expose this from `SqliteStorage` (e.g. `hydrateBatch(points)` or a
  `runInHydrationTransaction(fn)` wrapper) rather than leaking raw SQL to
  `StorageManager`.
- [x] 2.5 Tests: batch delete removes rows from both tables and returns the exact
  count (missing ids counted as zero); hydration with a mid-batch constraint
  violation keeps every other point in the collection and logs the failure
  (existing best-effort contract, `src/storage/index.ts:437-448`); savepoint
  rollback leaves the outer transaction committable under sql.js.

## 3. Prepared-statement cache

- [x] 3.1 Add a `Map<string, Statement>` cache to `SqliteStore`, used by a
  `preparedQuery(sql)` helper for fixed-SQL call sites only (start with
  `getMemoryById`, `countMemories` both variants, `countByTier`,
  `countUnsyncedVectors`, `countArchivedMemories`, `listAudit`); reuse via
  `reset()` + `bind()`. Dynamically assembled SQL (cursor/filter variants) keeps the
  existing prepare-free path.
- [x] 3.2 Free every cached statement and clear the map in `close()`
  (`src/storage/sqlite.ts:1560-1564`) and in `reloadFromDisk()`
  (`src/storage/sqlite.ts:375-391`) before `this.db` is replaced — a cached
  `Statement` must never outlive its `Database` handle.
- [x] 3.3 Tests: repeated calls reuse one statement (spy on `db.prepare`), results
  are identical to the uncached path, and a `reloadFromDisk()` followed by a cached
  query neither crashes nor returns stale data.

## 4. History-table pruning

- [x] 4.1 Add to the retention config block (`src/config/index.ts:121-145`):
  `audit_log_max_entries` (int, positive, nullable, default `50000`) and
  `revisions_per_memory_max` (int, positive, nullable, default `20`); `null`
  disables the corresponding prune.
- [x] 4.2 Add `pruneAuditLog(maxEntries: number): number` to `SqliteStore`: delete
  all but the newest `maxEntries` rows by `timestamp` (index `idx_audit_timestamp`,
  `src/storage/sqlite.ts:252`), returning the number pruned. Note there is currently
  no `DELETE FROM audit_log` anywhere in `src/` — insert side is
  `src/storage/sqlite.ts:1490`.
- [x] 4.3 Add `pruneRevisions(maxPerMemory: number): number`: for each `memory_id`
  keep the `maxPerMemory` highest `revision` values, delete the rest (insert side is
  `insertRevision`, `src/storage/sqlite.ts:1310`; table DDL `:262-270`). Must not
  break `listRevisions` ordering or the `memory://{id}/revisions` resource.
- [x] 4.4 Invoke both from `RetentionService.runGc`'s destructive phase (before the
  `flushIfDirty()`/`setRetentionDegraded` bookkeeping at
  `src/backup/retention.ts:170-178`), skipped on `dryRun`; add
  `audit_pruned`/`revisions_pruned` counts to `GarbageCollectionResult`
  (`src/backup/retention.ts:8-36`) and to the `retention_gc` log event.
- [x] 4.5 Tests: caps enforced (newest audit rows and highest revisions survive),
  `null` disables pruning, dry-run prunes nothing, prune counts surface in the GC
  result, and a pruned store round-trips through flush + `reloadFromDisk`.

## 5. Health scan dedupe and stats cache

- [x] 5.1 In `HealthService.check()` (`src/health/index.ts:24-61`), compute
  `countByTier` and `countUnsyncedVectors` once; change `checkRetention()`
  (`src/health/index.ts:163-177`, dup call at `:172`) to accept the tier counts and
  `checkVectorReconciliation()` (`:179`, dup call at `:180`) to accept the unsynced
  count as parameters.
- [x] 5.2 Cache the SQLite stats block — `memory_count`, `db_size_bytes`, tier
  counts, `expiring_soon`, `archived_count`, `unsynced_vectors` — for 5s using the
  `cachedEmbeddingHealth` pattern (`src/health/index.ts:12-14`); component statuses
  and lifecycle/degraded flags stay uncached. Rationale: `/health` bypasses auth
  (`src/transport/middleware.ts:30`) and its handler recomputes everything per
  request (`src/transport/http.ts:71-74`).
- [x] 5.3 Tests: one poll invokes each aggregate exactly once (spies on the sqlite
  methods); a second poll inside the TTL invokes none of them; a poll after the TTL
  refreshes; degraded-status transitions are visible immediately regardless of the
  stats cache.

## 6. generateSummary allocation fix

- [x] 6.1 Rewrite `generateSummary` (`src/domain/normalize.ts:15-19`) to find the
  first newline with `indexOf('\n')` and `substring`, instead of
  `content.split('\n')[0]`; behavior (including the `maxLen`/ellipsis path) is
  unchanged for all inputs.
- [x] 6.2 Extend `src/domain/normalize.test.ts`: single-line content, multi-line
  content, empty string, and a first line longer than `maxLen` all produce output
  identical to the previous implementation.

## 7. Docs and validation

- [x] 7.1 Document `retention.audit_log_max_entries` and
  `retention.revisions_per_memory_max` (defaults, `null` = never prune, enforced by
  scheduled cleanup/`gc`) in `README.md` and mirror in `README.de.md`,
  `README.es.md`, `README.fr.md`, `README.zh-CN.md`; bump `package.json` `version`.
  `.env.example` unchanged — no new env vars.
- [x] 7.2 `npm run lint` passes (tsc + eslint, no `any` casts).
- [x] 7.3 `npm test` passes.
