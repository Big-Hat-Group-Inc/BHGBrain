# Tasks: New-Device Bootstrap

1. ~~**Add `scanAllCollections()` to `src/storage/qdrant.ts`**~~ – Lists all `bhgbrain_*` collections, scrolls all points in each, returns array of `{ collectionName, points }`. *(Note: `listAllCollections()` and `scrollAll()` already exist — this task is already satisfied by existing methods.)* **[DONE]**

2. ~~**Add `upsertMemoryFromPayload()` to `src/storage/sqlite.ts`**~~ – Idempotent insert by ID using `INSERT OR IGNORE`. Reconstructs a memory row from a Qdrant point payload. Skips rows that already exist. **[DONE]**

3. ~~**Add `bootstrapFromQdrant()` to `src/storage/index.ts` on `StorageManager`**~~ – Calls `listAllCollections()`, scrolls each, calls upsert for each point, logs progress per collection, returns total count. **[DONE]**

4. ~~**Add startup hydration to `src/index.ts`**~~ – After SQLite init, if `memory_count === 0`, call `bootstrapFromQdrant()` and log results. Wrapped in try/catch. **[DONE]**

5. ~~**Add `repair --from-qdrant` to `src/cli/index.ts`**~~ – Calls `bootstrapFromQdrant()` and prints summary. **[DONE]**

6. ~~**Build and test**~~ – `npm run build` and `npm test` must pass. **[DONE]**
   - 5 tests added to `sqlite.test.ts`: insert from payload, idempotency, defaults, epoch expires_at conversion, FTS population
   - 4 tests added to `storage/index.test.ts`: hydration count, empty collections, idempotency skip, logger passthrough
   - 2 tests added to `cli/index.test.ts`: `repair --from-qdrant` success, repair without flags error
   - All 145 tests passing (134 existing + 11 new)
