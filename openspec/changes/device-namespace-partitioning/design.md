## Architecture

### Device Identity Resolution

A new `device` config section is added to the configuration schema:

```typescript
device: z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/).optional(),
}).default({})
```

Resolution order:
1. Explicit `device.id` in `config.json`
2. `BHGBRAIN_DEVICE_ID` environment variable
3. Auto-generated from `os.hostname()`, lowercased and sanitized to `[a-zA-Z0-9._-]`

On first run, the resolved `device_id` is written back to `config.json` so it remains stable across restarts even if the hostname changes.

### Storage Changes

#### SQLite Schema

Add `device_id` column to the `memories` table:

```sql
ALTER TABLE memories ADD COLUMN device_id TEXT;
```

Column is nullable for backward compatibility with pre-migration records. The column migration is added to `ensureMemoryColumns()` in `sqlite.ts`.

Insert and update paths set `device_id` from the resolved config value.

#### Qdrant Payload

Every `upsert` call includes `device_id` in the payload object alongside existing fields (namespace, type, tags, content, summary, etc.).

A `device_id` keyword index is created in `ensureCollection()`:

```typescript
await this.client.createPayloadIndex(name, {
  field_name: 'device_id',
  field_schema: 'keyword',
});
```

### Domain Model

`MemoryRecord` in `src/domain/types.ts` gains:

```typescript
device_id?: string | null;
```

`SearchResult` gains:

```typescript
device_id?: string | null;
```

### Write Path

In `src/storage/index.ts`, `writeMemory` and `updateMemory`:
- Accept `device_id` from the tool context (passed through from config)
- Include it in both the SQLite insert and the Qdrant upsert payload

The `WritePipeline` in `src/pipeline/index.ts` receives `device_id` from the tool context and passes it through to storage.

### Search Path

In `src/search/index.ts`, `buildSearchResults`:
- Includes `device_id` from SQLite records in the search result
- For Qdrant-fallback results (SQLite miss), reads `device_id` from the Qdrant payload

### Repair Tool

The `repair` tool handler in `src/tools/index.ts`:
- Accepts optional `device_id` filter parameter
- When `device_id` is provided, only recovers points matching that device
- When omitted, recovers all points (current behavior)
- Sets the local device's `device_id` on recovered records if the original point has no `device_id`

### Config Initialization

In `src/config/index.ts`:
- Add `device` section to `ConfigSchema`
- In `ensureDataDir` or a new `resolveDeviceId()` function: resolve the device ID per the resolution order and persist it

### Tool Context

The `ToolContext` interface in `src/tools/index.ts` already has `config`. The `device_id` is accessed via `ctx.config.device.id` — no interface changes needed.

## File Changes

| File | Change |
|---|---|
| `src/config/index.ts` | Add `device` config section, `resolveDeviceId()`, persist on first run |
| `src/domain/types.ts` | Add `device_id` to `MemoryRecord` and `SearchResult` |
| `src/domain/schemas.ts` | Add `device_id` to `RepairInputSchema` |
| `src/storage/sqlite.ts` | Add column migration, include `device_id` in insert/update/rowToMemory |
| `src/storage/qdrant.ts` | Add `device_id` index in `ensureCollection` |
| `src/storage/index.ts` | Pass `device_id` in writeMemory/updateMemory Qdrant payload |
| `src/pipeline/index.ts` | Thread `device_id` from caller through to storage |
| `src/search/index.ts` | Include `device_id` in search results and Qdrant fallback |
| `src/tools/index.ts` | Pass `device_id` from config into pipeline/storage calls; update repair handler |
| `src/tools/schemas.ts` | Add `device_id` filter to repair tool schema |

## Migration

- **SQLite**: Handled automatically by `ensureMemoryColumns()` — adds nullable `device_id` column if missing.
- **Qdrant**: Handled automatically by `ensureCollection()` — creates `device_id` keyword index. Existing points without `device_id` in payload are unaffected (index handles nulls).
- **Config**: Auto-resolves and persists `device_id` on first startup after upgrade.

## Backward Compatibility

- Memories without `device_id` (pre-migration) are treated as `device_id: null` everywhere.
- No MCP tool interface changes — `device_id` is additive in search results.
- Existing callers that don't pass `device_id` to `remember` get the server's configured device ID automatically.
