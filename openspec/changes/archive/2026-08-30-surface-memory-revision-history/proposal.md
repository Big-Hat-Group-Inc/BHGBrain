## Why

The write path already records a full revision history: `memory_revisions`
(`src/storage/sqlite.ts:247`) is populated on every content change
(`src/storage/sqlite.ts:1062`) and a read method exists
(`src/storage/sqlite.ts:1069`), typed as `MemoryRevisionRecord`
(`src/domain/types.ts:204`). But **no tool or resource exposes any of it**.

Meanwhile the write pipeline makes silent overwrites routine: any candidate landing in
the UPDATE similarity band (≥ the 0.92 default threshold) replaces the existing
memory's content outright (`src/pipeline/index.ts:162-195`). A user or agent has no
way to see what a memory used to say, discover that an aggressive dedup UPDATE
clobbered something, or undo it. The data to answer all three questions is already on
disk — it is write-only.

## What Changes

- Add a `memory://{id}/revisions` resource template returning the revision list for a
  memory (revision number, content, updated_at, updated_by), newest first, honoring
  the same expiry/namespace visibility rules as `memory://{id}`.
- Add a `revisions` MCP tool with actions:
  - `list` — same data as the resource, for clients that prefer tools.
  - `revert` — restore a memory's content to a chosen revision: runs through
    `StorageManager.updateMemory` so the vector is re-embedded and re-upserted, records
    the revert itself as a new revision, and writes a `REVISE` lifecycle audit event
    (the `LifecycleAuditOperation` type and `logAudit` plumbing already exist).
- Register the tool in `src/tools/schemas.ts` + `src/tools/index.ts` and the resource
  in `src/resources/index.ts` (including `ListResourceTemplates`).
- Update `README.md` § MCP Tools Reference + resources list, the four translated
  READMEs, and `CLAUDE.md`'s canonical MCP surface lists; bump `package.json` version.

## Capabilities

### New Capabilities
- `memory-revision-history`: The revision history that the write path already records
  is readable, and a memory's content can be reverted to a prior revision with full
  vector re-sync and audit trail.

### Modified Capabilities

## Impact

- Affected code: `src/tools/schemas.ts`, `src/tools/index.ts`,
  `src/resources/index.ts`, `src/storage/index.ts` (revert helper), co-located tests.
- Storage: no schema change — the table and insert/read methods exist.
- MCP surface grows by one tool and one resource template → CLAUDE.md's canonical
  lists and README ×5 must move in the same change (repo rule).
- Embedding provider is required for revert (re-embed); revert SHALL fail cleanly
  with `EMBEDDING_UNAVAILABLE` rather than desync the vector, mirroring the degraded
  write path's `vector_synced: false` convention if a fallback is chosen instead.
