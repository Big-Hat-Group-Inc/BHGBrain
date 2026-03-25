# Design: New-Device Bootstrap

## Architecture

Three integration points:

1. **QdrantStore** – already exposes `listAllCollections()` (returns `bhgbrain_*`
   collection names) and `scrollAll(collectionName)` (pages through all points).
   No new methods required.

2. **StorageManager** – new `bootstrapFromQdrant()` method that orchestrates the
   scan-and-upsert flow. Returns the total number of hydrated records.

3. **Startup hook** (`src/index.ts`) – after SQLite init and health check, if
   `memory_count === 0`, call `bootstrapFromQdrant()` and log results. Wrapped
   in try/catch so failures warn but do not crash startup.

4. **CLI** (`src/cli/index.ts`) – `repair --from-qdrant` flag calls
   `bootstrapFromQdrant()` and prints a summary.

## Hydration Algorithm

```
1. collections = qdrant.listAllCollections()          // all bhgbrain_* names
2. log "[bootstrap] hydrating from qdrant: found N collections"
3. for each collection:
     points = qdrant.scrollAll(collectionName)
     for each point:
       record = reconstructMemoryRecord(point.id, point.payload)
       sqlite.run("INSERT OR IGNORE INTO memories (...) VALUES (...)", params)
       sqlite.run("INSERT OR IGNORE INTO memories_fts (...) VALUES (...)", params)
     sqlite.flushIfDirty()
     log "[bootstrap] collection X: M points hydrated"
4. return totalHydrated
```

The `INSERT OR IGNORE` makes hydration idempotent – existing rows are skipped.

## Payload Field Mapping

| Qdrant payload field | MemoryRecord field | Default if missing |
|---|---|---|
| `id` (point ID) | `id` | required |
| `content` | `content` | `""` |
| `summary` | `summary` | `""` |
| `namespace` | `namespace` | `"global"` |
| `collection` | `collection` | `"general"` |
| `type` | `type` | `"semantic"` |
| `tags` | `tags` | `[]` |
| `importance` | `importance` | `0.5` |
| `retention_tier` | `retention_tier` | `"T2"` |
| `device_id` | `device_id` | `null` |
| `created_at` | `created_at` | `now()` |
| `source` | `source` | `"import"` |
| `category` | `category` | `null` |
| `decay_eligible` | `decay_eligible` | `true` |
| `expires_at` | `expires_at` | `null` |

Fields not in payload (`access_count`, `last_operation`, `merged_from`, etc.)
receive safe defaults.

## CLI

```
bhgbrain repair --from-qdrant
```

Calls `storage.bootstrapFromQdrant()` and prints:
```
[repair] hydrated N memories from Qdrant
```

## Progress Logging

- `[bootstrap] hydrating from qdrant: found N collections`
- `[bootstrap] collection <name>: M points hydrated`
- `[bootstrap] complete: N total memories hydrated`
