# BHGBrain Memory System Code Review

Scope reviewed:
- `src/storage`
- `src/pipeline`
- `src/search`
- `src/resources`
- `src/backup`
- `src/index.ts`
- relevant tests under `src/**/*.test.ts`

Focus areas:
- performance under larger memory volumes
- stability and cross-store consistency
- garbage cleanup, retention, archival, and persistence lifecycle

## Findings

### 1. High: backup restore can race with deferred flush and overwrite restored state

Files:
- `src/storage/sqlite.ts:151-164`
- `src/storage/sqlite.ts:180-185`
- `src/backup/index.ts:91-104`

Why this matters:
- `SqliteStore` keeps a deferred flush timer for read-path access updates.
- `reloadFromDisk()` closes and replaces the in-memory `sql.js` database without cancelling that timer or flushing pending dirty state first.
- During backup restore, `BackupService.restore()` atomically writes the backup to disk and then calls `reloadSqliteFromDisk()`.

Risk:
- A pending timer created before restore can fire after the restore and export whichever in-memory state happens to be current at that moment.
- That can re-persist pre-restore mutations, wipe out the freshly restored snapshot, or drop recent access-state updates nondeterministically.

Recommended fix:
- In `reloadFromDisk()`, call `cancelDeferredFlush()` first.
- Decide explicitly whether pending dirty state should be flushed or discarded before replacing the DB.
- Add a restore-time lock so reads/writes cannot schedule new deferred flushes during activation.

### 2. High: retention GC does serial network deletes and synchronous flushes per memory

Files:
- `src/backup/retention.ts:54-64`
- `src/storage/index.ts:123-133`
- `src/storage/index.ts:154-164`

Why this matters:
- `runGc()` loops through every expired memory one at a time.
- Each iteration does:
  - optional archive write
  - awaited Qdrant delete
  - SQLite delete + flush
  - audit insert + flush

Risk:
- Cleanup time scales poorly with expired volume.
- Large retention runs will spend most of their time in per-item fsync/export and remote round-trips.
- Partial progress is committed incrementally, so transient Qdrant instability leaves cleanup half-finished and expensive to resume.

Recommended fix:
- Batch expired IDs by collection/namespace where possible.
- Stage SQLite mutations in memory and flush once per GC pass.
- Batch audit writes.
- Add a bulk vector-delete API in `QdrantStore` or at least group deletions per collection.

### 3. High: collection cleanup can silently leave orphaned vectors in Qdrant

Files:
- `src/storage/index.ts:140-147`
- `src/storage/qdrant.ts:181-187`

Why this matters:
- `deleteCollectionData()` deletes SQLite rows first and flushes them before deleting the Qdrant collection.
- `QdrantStore.deleteCollection()` swallows every exception, not just "collection not found".

Risk:
- If Qdrant is unavailable or returns a non-404 error, the method still appears successful.
- SQLite is already committed, so the system loses the authoritative list of IDs needed to reconcile the orphaned vectors.
- This directly undermines garbage cleanup and cross-store consistency.

Recommended fix:
- Only ignore explicit "not found" responses from Qdrant.
- Reverse the order or add a reconciliation strategy:
  - mark collection rows pending deletion
  - delete vectors
  - finalize SQLite delete on success
- Emit a health signal or audit record when vector cleanup fails.

### 4. Medium: auto-inject builds oversized transient strings and loads all category content before truncation

Files:
- `src/resources/index.ts:119-166`
- `src/storage/sqlite.ts:637-645`

Why this matters:
- `buildInjectPayload()` loads full category bodies for every category.
- It appends them all to `parts` without checking the `max_chars` budget first.
- Only after all content is assembled does it join and substring the final string.

Risk:
- Large category bodies create unnecessary allocations and heap churn.
- The endpoint can do a lot of work to produce content that is immediately truncated away.
- This is avoidable garbage creation on a path intended for frequent context assembly.

Recommended fix:
- Stop appending once `max_chars` is reached.
- Fetch lightweight category metadata first, then stream or append content incrementally within budget.
- Consider a dedicated query for preview-sized category content when building inject payloads.

### 5. Medium: search paths use N+1 SQLite lookups and per-hit mutation writes

Files:
- `src/search/index.ts:68-90`
- `src/search/index.ts:99-123`
- `src/search/index.ts:181-205`

Why this matters:
- Semantic, fulltext, and hybrid search all fetch candidate IDs first, then call `getMemoryById()` once per result.
- Each hit also records access and marks SQLite dirty.

Risk:
- Query cost grows with result count instead of staying near O(1) round-trips.
- Hybrid search is especially expensive because it fuses two result sets and then performs per-item lookups anyway.
- Frequent searches increase write pressure on the in-memory DB and deferred flush system even though the request is logically read-heavy.

Recommended fix:
- Add a `getMemoriesByIds(ids: string[])` API and hydrate results in one SQL query.
- Consider sampling or debouncing access-count updates for search results instead of mutating every returned hit.
- Reuse a single `now` timestamp per search call to reduce repeated date parsing/allocation.

### 6. Medium: degraded embedding fallback bypasses collection metadata and compatibility checks

Files:
- `src/pipeline/index.ts:246-303`
- `src/storage/index.ts:19-67`

Why this matters:
- Normal writes go through `StorageManager.writeMemory()`, which creates collection metadata and enforces embedding-space compatibility.
- `deterministicFallback()` writes directly to SQLite instead.

Risk:
- Collections created during degraded mode may never be registered in the `collections` table.
- Later recovery or cleanup workflows lose authoritative metadata about embedding model/dimensions for those unsynced rows.
- This increases the chance of repair jobs and retention tooling operating on incomplete metadata.

Recommended fix:
- Route fallback writes through a SQLite-only storage path that still records collection metadata.
- Preserve the same collection compatibility invariants even when vectors are unavailable.

## Testing Gaps

Missing tests that would catch the issues above:
- backup restore with a pending deferred flush timer
- GC performance/behavior with hundreds or thousands of expired memories
- collection deletion when Qdrant returns a transient failure
- inject payload generation with very large category bodies
- degraded-mode writes followed by later vector reconciliation

## Overall Assessment

The core design is workable, and the project already has useful retention metadata, archival support, and vector drift tracking. The weakest part of the current implementation is lifecycle coordination between the in-memory SQLite store, deferred flush timer, and Qdrant cleanup paths. The biggest practical risks are silent drift between SQLite and Qdrant, restore-time persistence races, and cleanup routines that will become disproportionately expensive as the memory corpus grows.
