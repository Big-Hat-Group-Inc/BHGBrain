# Proposal: New-Device Bootstrap – Hydrate SQLite from Qdrant

## Why

When BHGBrain is installed on a new device the local SQLite database starts empty.
Qdrant Cloud already holds memories written by other devices (141 vectors across
8 collections were observed on Device 2, CPCCA-2HTF0H), but all searches return
empty because the search path JOINs Qdrant vector results against local SQLite
metadata rows. With no rows in SQLite, every cross-device memory is silently
dropped and `memory_count` reports 0.

## What Changes

1. **Startup auto-hydration** – After the health check, if SQLite `memory_count === 0`
   and Qdrant has collections with points, automatically scan all `bhgbrain_*`
   Qdrant collections, reconstruct `MemoryRecord` rows from payload fields, and
   upsert into SQLite.
2. **`bhgbrain repair --from-qdrant`** – A CLI command to trigger the same
   hydration on demand, regardless of memory count.

### Audit-driven amendments (2026-06-05)

3. **Atomic, fail-loud hydration** – Hydration must be atomic per memory. A Qdrant
   payload that violates the `memories.type` CHECK constraint must fail loudly rather
   than being silently dropped while an orphan `memories_fts` row is left behind and
   the hydrated count is over-reported. The original implementation
   (`upsertMemoryFromPayload`) used two non-transactional `INSERT OR IGNORE` statements
   that recreate the exact silent-drop failure this proposal set out to fix; `type` is
   now validated against the enum and the inserts are made atomic.
4. **`repair` contract alignment** – The `repair --from-qdrant` flow is reconciled with
   `device-namespace-partitioning` so the `repair` device-scoping contract is
   single-sourced (see Decision 6 in design.md).

## Capabilities

| Capability | Description |
|---|---|
| `new-device-bootstrap-hydration` | Automatic SQLite hydration on startup when empty |
| `repair-from-qdrant` | On-demand CLI hydration from Qdrant payloads |

## Impact

- **StorageManager** – gains `bootstrapFromQdrant()` method
- **QdrantStore** – already has `listAllCollections()` and `scrollAll()` (no changes needed)
- **Startup sequence** (`src/index.ts`) – calls bootstrap after init
- **CLI** (`src/cli/index.ts`) – new `repair --from-qdrant` subcommand

## Non-Goals

- Real-time cross-device sync
- Conflict resolution between divergent SQLite databases
- Per-device filtering (handled by device-namespace-partitioning)
