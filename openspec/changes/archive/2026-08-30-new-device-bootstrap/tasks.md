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

## Audit follow-ups (2026-06-05)

7. **BUG: hydration silently drops constraint-violating rows and leaves orphan FTS entries** (`src/storage/sqlite.ts:413-431`, `upsertMemoryFromPayload`)
   - [x] 7.1 The Qdrant→SQLite hydration runs two independent, non-transactional `INSERT OR IGNORE` statements. The `memories.type` column carries `CHECK(type IN ('episodic','semantic','procedural'))` (`src/storage/sqlite.ts:140`), but the payload `type` is reconstructed verbatim with only a `typeof === 'string'` guard. A payload whose `type` is any other string is silently dropped from `memories` by `OR IGNORE`, while the `memories_fts` insert still succeeds and the method returns `true` — leaving an orphan FTS row, inflating the hydrated count, and recreating the exact silent-drop failure this proposal set out to fix (full-text search returns an id that `getMemoryById` cannot load).
   - [x] 7.2 Validate `type` against the allowed enum before insert (fall back to the documented `'semantic'` default on mismatch) so a bad row never violates the CHECK.
   - [x] 7.3 Make hydration atomic per memory: wrap both inserts in a single transaction (and/or gate the FTS insert + `return true` on the `memories` insert actually applying, e.g. via `db.getRowsModified()`), so a constraint violation fails loudly instead of leaving an orphan FTS row or over-reporting the count.
   - [x] 7.4 Add a regression test for an out-of-enum `type` payload: assert no orphan `memories_fts` row is left, that the hydrated count is accurate, and that the row is either normalized to the default or fails loudly (no silent drop).

   Implementation: `upsertMemoryFromPayload` now validates `type` against
   `ALLOWED_MEMORY_TYPES` before insert (falling back to `'semantic'`), and wraps the
   `memories` + `memories_fts` inserts in a `BEGIN TRANSACTION` / `COMMIT`, with the
   `memories` insert changed from `INSERT OR IGNORE` to a plain `INSERT` so a genuine
   constraint violation throws and triggers a `ROLLBACK` instead of being swallowed.
   `bootstrapFromQdrant` now catches a per-point throw, logs it loudly via
   `logger.warn` (`event: 'bootstrap_hydration_failed'`), and continues with the next
   point instead of over-counting or aborting the whole scan. Regression tests:
   `src/storage/sqlite.test.ts` ("normalizes an out-of-enum type...", "rolls back the
   memories insert if the FTS insert fails..."), `src/storage/index.test.ts`
   ("continues hydrating remaining points when one point throws...").

8. **DRIFT: `repair` contract diverges from `device-namespace-partitioning`** (`src/storage/index.ts:175`, `src/cli/index.ts:388`)
   - [x] 8.1 `bootstrapFromQdrant` / `repair --from-qdrant` hydrate *every* device's memories with no `device_id` predicate, while `device-namespace-partitioning` specifies that `repair` scopes to the current device (or `--all-devices`). Reconcile the two so the `repair` contract is single-sourced: either add an optional `device_id` filter (default `config.device.id`, `--all-devices` override) to `bootstrapFromQdrant` and the CLI, or formally delegate the unfiltered hydration to this command and align the partitioning spec/naming accordingly.

   Implementation: `bootstrapFromQdrant(logger?, options?: { deviceId?: string | null;
   allDevices?: boolean })` gained an opt-in `options` parameter. The CLI
   `bhgbrain repair --from-qdrant` now defaults to `deviceId: ctx.config.device?.id`
   (skipping points whose payload `device_id` doesn't match, matching
   `device-namespace-partitioning`'s `handleRepair` semantics for points missing
   `device_id`) and accepts a new `--all-devices` flag to hydrate every device, mirroring
   that change's `repair` contract. The automatic startup hook in `src/index.ts` calls
   `bootstrapFromQdrant(logger)` with no `options`, so it stays unfiltered — it exists
   specifically to recover *other* devices' memories onto a fresh, empty local SQLite,
   which device-scoping by default would defeat. Tests:
   `src/storage/index.test.ts` ("scopes hydration to the given device_id by default...",
   "--all-devices hydrates every device..."), `src/cli/index.test.ts` ("repair
   --from-qdrant scopes to the configured device by default", "repair --from-qdrant
   --all-devices hydrates every device").
