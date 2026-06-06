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

## Decisions (audit follow-ups, 2026-06-05)

Reference: `codeaudit/device-namespace-partitioning-2026-06-05-02-19.md`.

### D1. Idempotent index migration on existing collections

`ensureCollection` originally created the `device_id` keyword index only inside the
collection-not-found `catch` branch, so existing collections returned early and were
never migrated — the exact post-upgrade multi-device Qdrant Cloud scenario the proposal
targets. **Decision:** ensure the `device_id` payload index **unconditionally** on every
`ensureCollection` call (after the create/exists branch), wrapped in a try/catch that
tolerates an "already exists" conflict so it is idempotent across restarts. `createPayloadIndex`
in Qdrant is effectively idempotent; the only cost is a cheap no-op call per boot.

### D2. Env precedence: `BHGBRAIN_DEVICE_ID` wins over persisted `device.id`

The original resolution returned `config.device.id` before consulting the env var, and
because the resolved id is persisted, `BHGBRAIN_DEVICE_ID` was permanently ignored after
first run — contradicting the project-wide "env vars take precedence over file-based
config" contract. **Decision:** `BHGBRAIN_DEVICE_ID`, when set, **overrides** the
persisted `device.id`, and the override is re-persisted. Resolution order becomes:
`BHGBRAIN_DEVICE_ID` env → persisted `config.device.id` → `os.hostname()` (sanitized).
This keeps Docker/W365 re-homing working as documented. `sanitizeDeviceId` is also
reordered to slice-then-strip-trailing-hyphen so truncation cannot reintroduce a `-`.

### D3. Conditional config write

The original `ensureDataDir` rewrote `config.json` on every startup, expanding all Zod
defaults and stripping user formatting/comments. **Decision:** persist `config.json`
**only** when the device id was newly synthesized (or the config file is absent),
determined by a flag returned from `resolveDeviceId` (or a before/after comparison).
Steady-state startups perform no config write.

### D4. Explicit `--all-devices` flag

"All devices" was implemented implicitly (omit `device_id`). **Decision:** add an
explicit `all_devices` boolean to `RepairInputSchema` and the repair MCP schema as the
documented all-devices path, mutually exclusive with `device_id`. (Out of scope here but
noted by the audit: the repair filter still runs client-side after `scrollAll`, so the
new index is not yet load-bearing for repair; pushing the filter server-side is a
separate optimization.)
