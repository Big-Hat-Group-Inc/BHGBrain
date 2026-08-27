## Tasks

### 1. Add device config section and resolution logic
**File**: `src/config/index.ts`
**Effort**: Small

- Add `device` section to `ConfigSchema` with optional `id` field (regex: `^[a-zA-Z0-9._-]{1,64}$`)
- Add `resolveDeviceId(config)` function: checks `config.device.id` → `BHGBRAIN_DEVICE_ID` env → `os.hostname()` (lowercased, sanitized)
- Persist resolved `device_id` back to `config.json` in `ensureDataDir` if not already set
- Export resolved device ID on the config object

### 2. Add device_id to domain types
**File**: `src/domain/types.ts`
**Effort**: Small

- Add `device_id?: string | null` to `MemoryRecord` interface
- Add `device_id?: string | null` to `SearchResult` interface

### 3. Add device_id column to SQLite
**File**: `src/storage/sqlite.ts`
**Effort**: Small

- Add `device_id TEXT` column migration in `ensureMemoryColumns()`
- Include `device_id` in `insertMemory()` SQL and parameter list
- Include `device_id` in `rowToMemory()` mapping
- Include `device_id` in `updateMemory()` field handling

### 4. Add device_id index to Qdrant
**File**: `src/storage/qdrant.ts`
**Effort**: Small

- Add `device_id` keyword index creation in `ensureCollection()`

### 5. Thread device_id through write path
**Files**: `src/storage/index.ts`, `src/pipeline/index.ts`
**Effort**: Medium

- `StorageManager.writeMemory`: Accept `device_id` parameter, include in SQLite insert and Qdrant upsert payload
- `StorageManager.updateMemory`: Same treatment
- `WritePipeline.process`: Accept `device_id` from caller, pass through to storage manager
- Ensure the `remember` tool handler passes `ctx.config.device.id` into the pipeline

### 6. Include device_id in search results
**File**: `src/search/index.ts`
**Effort**: Small

- In `buildSearchResults`: include `device_id` from SQLite record in search result
- For Qdrant-fallback path: read `device_id` from Qdrant payload

### 7. Update repair tool with device filtering
**Files**: `src/tools/index.ts`, `src/tools/schemas.ts`, `src/domain/schemas.ts`
**Effort**: Small

- Add optional `device_id` string field to `RepairInputSchema`
- Add `device_id` filter description to repair tool MCP schema
- In `handleRepair`: filter Qdrant points by `device_id` when provided
- Set current device's `device_id` on recovered records if original has none

### 8. Update remember handler to pass device_id
**File**: `src/tools/index.ts`
**Effort**: Small

- In `handleRemember`: pass `ctx.config.device.id` to `pipeline.process()`
- Ensure all write paths consistently tag with the device identity

### 9. Build and test
**Effort**: Small

- Run `npm run build` — must compile cleanly
- Run `npm test` — all existing tests must pass
- Manually verify: start server, call `remember`, confirm `device_id` appears in both SQLite and Qdrant payload

## Audit follow-ups (2026-06-05)

Source: `codeaudit/device-namespace-partitioning-2026-06-05-02-19.md`. The feature is
wired end-to-end but has one real migration bug plus several contract drifts, and the
new logic is effectively untested.

### 10. BUG: Qdrant device_id index never migrates onto existing collections
**File**: `src/storage/qdrant.ts` (`ensureCollection`, `:38-73`)
**Severity**: High
**Effort**: Small

- [x] 10.1 The `device_id` keyword index is created **only inside the
  collection-not-found `catch` branch** (`:42-73`), so any collection that already
  exists returns early at `:41` and never gets the index — this is exactly the
  post-upgrade multi-device Qdrant Cloud case the proposal targets.
- [x] 10.2 Move the `createPayloadIndex` call for `device_id` out of the `catch` so it
  runs **unconditionally and idempotently** on existing collections too (run it after
  the try/catch, or in both branches).
- [x] 10.3 Make it idempotent: wrap in a try/catch that tolerates an "already exists"
  conflict from Qdrant so repeated startups are no-ops.
- [x] 10.4 Add a regression test asserting the `device_id` index is created when the
  collection already exists (see 14.x).

### 11. DRIFT: config.json rewritten unconditionally on every boot
**File**: `src/config/index.ts` (`ensureDataDir` / `resolveDeviceId`, `:287-291`)
**Severity**: Medium
**Effort**: Small

- [x] 11.1 `ensureDataDir` always `writeFileSync(configPath, ...)` after resolving the
  device id, rewriting the fully Zod-defaulted config every startup (strips user
  comments/formatting, avoidable disk write). Task 1 specifies "if not already set".
- [x] 11.2 Track whether `resolveDeviceId` actually **synthesized** a new id (return a
  flag or compare before/after) and only write `config.json` when the file is missing
  or `device.id` was newly assigned.

### 12. DRIFT: persisted device.id silently overrides BHGBRAIN_DEVICE_ID
**File**: `src/config/index.ts` (`resolveDeviceId`, `:266-274`)
**Severity**: Low (contract correctness)
**Effort**: Small

- [x] 12.1 `resolveDeviceId` returns `config.device.id` first (`:266-267`), before
  consulting `BHGBRAIN_DEVICE_ID` (`:270`); combined with persistence (#11) the env var
  is permanently ignored after first run. This contradicts the documented "env wins"
  contract (`:196-197`, `.env.example`).
- [x] 12.2 Make `BHGBRAIN_DEVICE_ID` take precedence over the persisted `device.id`:
  check the env var ahead of the file value, and re-persist when env overrides.
- [x] 12.3 Reconcile `sanitizeDeviceId` truncation while here: slice to 64 chars
  **then** strip a trailing hyphen (`.slice(0,64).replace(/-+$/,'') || 'unknown'`) so
  truncation cannot re-introduce a trailing `-` (`:248-254`).

### 13. DRIFT: --all-devices is an omit-filter, not an explicit flag
**Files**: `src/tools/index.ts` (`handleRepair`, `:305-319`), `src/tools/schemas.ts`,
`src/domain/schemas.ts`
**Severity**: Low
**Effort**: Small

- [x] 13.1 Today "all devices" is implicit: omitting `device_id` recovers every device
  (`:316`). The proposal documents an explicit `--all-devices` capability.
- [x] 13.2 Add an explicit boolean `all_devices` field to `RepairInputSchema` and the
  repair MCP schema, and have `handleRepair` treat it as the documented all-devices
  path (mutually exclusive with `device_id`); keep omit-behavior backward-compatible or
  document the precedence.

### 14. Tests: cover device tagging, repair filter, and index migration
**Files**: `src/storage/sqlite.test.ts`, `src/config/*.test.ts`,
`src/storage/qdrant.test.ts` (new), `src/tools/*.test.ts`
**Severity**: Medium
**Effort**: Small/Medium

- [x] 14.1 `resolveDeviceId` priority chain: explicit id / `BHGBRAIN_DEVICE_ID` /
  hostname fallback, **and the env-wins-over-persisted case** from #12.
- [x] 14.2 `sanitizeDeviceId` edge cases incl. the truncation/trailing-hyphen fix.
- [x] 14.3 Device tagging round-trip: a `remember` write tags `device_id` into both
  SQLite and the Qdrant payload, and search surfaces it (including the Qdrant-fallback
  path).
- [x] 14.4 Repair device filter: seed two devices' points, assert the filter recovers
  only the requested device, and that the local id is set on recovered records lacking
  one.
- [x] 14.5 Qdrant index migration: assert `ensureCollection` creates the `device_id`
  index when the collection **already exists** (regression for #10), and that a second
  call is a no-op.
