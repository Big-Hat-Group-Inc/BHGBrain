# Tasks: New-Device Bootstrap

1. **Add `scanAllCollections()` to `src/storage/qdrant.ts`** – Lists all `bhgbrain_*` collections, scrolls all points in each, returns array of `{ collectionName, points }`. *(Note: `listAllCollections()` and `scrollAll()` already exist — this task is already satisfied by existing methods.)*

2. **Add `upsertMemoryFromPayload()` to `src/storage/sqlite.ts`** – Idempotent insert by ID using `INSERT OR IGNORE`. Reconstructs a memory row from a Qdrant point payload. Skips rows that already exist.

3. **Add `bootstrapFromQdrant()` to `src/storage/index.ts` on `StorageManager`** – Calls `listAllCollections()`, scrolls each, calls upsert for each point, logs progress per collection, returns total count.

4. **Add startup hydration to `src/index.ts`** – After SQLite init, if `memory_count === 0`, call `bootstrapFromQdrant()` and log results. Wrapped in try/catch.

5. **Add `repair --from-qdrant` to `src/cli/index.ts`** – Calls `bootstrapFromQdrant()` and prints summary.

6. **Build and test** – `npm run build` and `npm test` must pass.
