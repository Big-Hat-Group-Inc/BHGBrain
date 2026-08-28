## Why

Two lifecycle features are half-built — the write side ships, the read side doesn't:

- **Review queue**: every T1 memory gets a `review_due` date
  (`src/domain/lifecycle.ts:69`, refreshed on promotion in
  `src/search/index.ts:310-312`), but nothing user-facing reads it. The field
  implements a curation loop ("periodically confirm long-lived memories are still
  true") whose second half doesn't exist: no way to list due memories, and no
  memory-level actions to disposition them.
- **Archive**: expired memories are preserved in `archived_memories`
  (`ArchiveRecord`, `src/domain/types.ts:192`; `archiveMemory`,
  `src/storage/sqlite.ts:997`) with summary, tags, tier, and access stats — but no
  tool or resource can search or restore them. "I know I used to know this" has a
  table and no query.

Both gaps make the tiered-lifecycle system feel lossy in practice even though the
data is retained by design.

## What Changes

- Add a `review` MCP tool:
  - `list` — memories whose `review_due` ≤ now (or within `days` ahead),
    namespace-scoped, paginated, oldest due first.
  - `keep` — confirm still-true: clears/re-extends `review_due` per lifecycle policy
    and refreshes `expires_at` per tier TTL.
  - `archive` — retire the memory through the existing archive path (vector removed,
    row archived), audited as `ARCHIVE`.
  - (revision happens via the normal `remember` UPDATE flow; `review` does not
    duplicate a content editor.)
- Extend the `search` tool with `include_archived: boolean` (default false):
  archived matches come from a fulltext-style query over `archived_memories`
  (summary + tags — content is not retained there), returned with an
  `archived: true` marker and no access recording.
- Add a `restore` action on `review` for archived entries: re-create an active
  memory from the archive record's summary/tags (content is gone — the restored
  memory is explicitly a stub carrying provenance), audited as `RESTORE`.
- Register schema/handler; update `CLAUDE.md` canonical tool list, README ×5, bump
  version.

## Capabilities

### New Capabilities
- `memory-review-and-archive-recall`: The review queue is actionable (list, keep,
  archive) and archived memories are searchable and restorable, closing the read side
  of the tiered lifecycle.

### Modified Capabilities

## Impact

- Affected code: `src/tools/schemas.ts`, `src/tools/index.ts`,
  `src/storage/sqlite.ts` (due-listing + archive fulltext queries),
  `src/domain/lifecycle.ts` (keep semantics), tests.
- MCP surface grows by one tool and one `search` parameter → CLAUDE.md + README ×5
  sync in the same change (repo rule).
- No schema migrations: both tables and all lifecycle fields already exist.
