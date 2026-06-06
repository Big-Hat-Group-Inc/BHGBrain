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

## Decisions (audit-driven, 2026-06-05)

5. **Hydration is atomic and fail-loud per memory.** The original
   `upsertMemoryFromPayload` ran two independent, non-transactional `INSERT OR IGNORE`
   statements. Because `memories.type` carries
   `CHECK(type IN ('episodic','semantic','procedural'))` and the payload `type` was
   reconstructed verbatim (only a `typeof === 'string'` guard), a payload with any other
   `type` string was silently dropped from `memories` while the `memories_fts` insert
   still succeeded and the method returned `true`. The net effect — an orphan FTS row, an
   inflated hydrated count, and a memory that surfaces in full-text search but cannot be
   loaded via `getMemoryById` — *recreates the exact silent cross-device drop this
   proposal exists to eliminate.* Decision: validate `type` against the allowed enum
   before insert (falling back to the documented `'semantic'` default on mismatch) **and**
   make the two inserts atomic — either by wrapping them in a single transaction or by
   gating the FTS insert and the `return true` on the `memories` insert actually applying
   (`db.getRowsModified()`). A constraint violation must fail loudly; it must never leave
   an orphan `memories_fts` row or over-report the count. A regression test exercises the
   out-of-enum `type` path.

6. **`repair` contract single-sourced with `device-namespace-partitioning`.**
   `bootstrapFromQdrant` and `repair --from-qdrant` originally hydrated every device's
   memories with no `device_id` predicate, contradicting `device-namespace-partitioning`,
   which scopes `repair` to the current device (or `--all-devices`). Decision: align the
   two contracts so `repair` device-scoping is defined in one place — add an optional
   `device_id` filter (default `config.device.id`, `--all-devices` override) to
   `bootstrapFromQdrant` and the CLI, or formally delegate the unfiltered hydration to
   this command and update the partitioning spec/naming to match. This proposal's prior
   "Per-device filtering is a Non-Goal" stance is superseded only to the extent needed to
   remove the ambiguity in the shared `repair` surface.
