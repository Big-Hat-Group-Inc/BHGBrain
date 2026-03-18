## Why

Multiple BHGBrain instances (e.g., primary workstation and W365 Cloud PC) share the same Qdrant Cloud backend but maintain separate local SQLite databases. Today there is no device-level isolation — both instances write to the same Qdrant collections with identical namespace keys, but their local SQLite stores diverge. This causes:

1. **Silent data loss on search**: Device B's SQLite is empty for memories written by Device A. The search join against local SQLite drops valid Qdrant results.
2. **Write collisions**: Both devices can write memories with the same checksum to the same namespace, causing dedup conflicts.
3. **No provenance**: No way to tell which device created a memory, making debugging and selective cleanup impossible.

The recent data loss incident (SQLite wiped on one device while Qdrant retained vectors) exposed this gap directly.

## What Changes

- Add a `device_id` configuration field that uniquely identifies each BHGBrain instance.
- Store `device_id` in every Qdrant payload and SQLite memory record as provenance metadata.
- Add a `device_id` payload index to Qdrant collections for efficient per-device filtering.
- Expose `device_id` in search results so callers can identify memory origin.
- Auto-generate a stable `device_id` on first run if not explicitly configured (based on hostname).
- The `repair` tool uses `device_id` to selectively recover only the current device's memories, or all memories with `--all-devices`.

## Capabilities

### New Capabilities
- `device-identity`: Stable per-instance identity derived from config or hostname, stored in config.json on first run.
- `device-provenance`: Every memory write tags the Qdrant payload and SQLite record with `device_id` for origin tracking.
- `device-aware-repair`: The repair tool can filter recovery by device, recovering only memories created by a specific instance or all instances.

### Modified Capabilities
- `core-storage-consistency`: Qdrant upsert payloads and SQLite insert/update include `device_id`. Qdrant collections get a `device_id` keyword index.
- `memory-domain-model`: `MemoryRecord` gains an optional `device_id` field. Search results include `device_id` when present.
- `write-decision-pipeline`: Dedup checksum lookups remain namespace-scoped (not device-scoped) to prevent cross-device duplicates.

## Impact

- Affects config loading, storage write paths, search result schema, and repair tool logic.
- Requires a one-time Qdrant payload index creation for `device_id` on existing collections (handled by `ensureCollection` on startup).
- Backward-compatible: memories without `device_id` are treated as `device_id: null` (pre-migration).
- No breaking changes to existing MCP tool interfaces — `device_id` is additive metadata.

## Non-Goals

- **Cross-device sync of SQLite**: Each device maintains its own SQLite independently. The `repair` tool is the recovery mechanism, not a sync protocol.
- **Device-scoped search filtering**: All devices see all memories by default. Per-device filtering may be added later but is not in scope.
- **Device authentication/authorization**: This is provenance tagging, not access control.
