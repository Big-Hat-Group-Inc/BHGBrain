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
