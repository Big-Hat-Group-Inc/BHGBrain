## Why

Every memory carries a `created_at` timestamp (`src/domain/types.ts:66`,
`memories.created_at TEXT NOT NULL` in `src/storage/sqlite.ts:198`), and it has been
written into the Qdrant payload unconditionally since the payload's inception
(`created_at: mem.created_at`, `src/storage/index.ts:821`). Yet neither `recall` nor
`search` exposes any way to query by it. "What did we decide last week" or "what did
we store before the migration" can only be answered by semantic luck — hoping the
embedding of a time-bounded question happens to rank the right memories above
everything else that has ever been stored on the topic. As the store ages this gets
worse, not better: an eight-month-old memory on the same subject is exactly as
reachable as one from yesterday.

The data needed to answer time-scoped queries already exists on every row, in both
stores, unconditionally. No backfill, no migration, no new column — this is a query
surface gap, not a storage gap.

A related idea — reconstructing what a memory's *content* looked like at a past point
in time using the revision history `surface-memory-revision-history` just exposed
(`memory_revisions`, `src/storage/sqlite.ts:262`) — is explicitly **out of scope** here
(see Design § Non-Goals). `after`/`before` filter on *which* memories existed and when
they were created; reconstructing historical *content* for memories that have since
been edited is a materially different problem (no historical embeddings exist, so
relevance ranking would still reflect today's content while the returned text reflected
yesterday's) and is left as a follow-up.

## What Changes

- Add optional `after` / `before` parameters (ISO 8601 timestamps) to the `recall` and
  `search` tool schemas (`src/tools/schemas.ts`), validated via
  `RecallInputSchema` / `SearchInputSchema` (`src/domain/schemas.ts`) with a
  `after <= before` refinement.
- Extend `RecallFilter` (`src/domain/types.ts:23`) with `after?: string` /
  `before?: string` and push both down into the stores, following the same pattern
  `push-down-recall-filters` established for `type`/`tags`:
  - `QdrantStore.search` (`src/storage/qdrant.ts`): a `range` clause on the existing
    `created_at` payload field, using Qdrant's native RFC 3339 datetime range support
    (no payload migration — the field has always been an ISO string). Add a `datetime`
    payload index on `created_at`, ensured unconditionally like the existing
    `device_id` index so pre-existing collections pick it up.
  - `SqliteStore.fullTextSearch` (`src/storage/sqlite.ts`): `created_at >= ?` /
    `created_at <= ?` predicates (ISO 8601 sorts lexicographically; the existing
    `idx_memories_created` index already covers it).
- Thread the filter through `handleRecall` and `handleSearch` (`src/tools/index.ts`) —
  `search` gains its first pushed-down filter (today it always passes `undefined`).
- Keep a defensive post-retrieval re-check against `created_at` (mirroring the
  `type`/`tags` re-check), observable via metrics if it ever fires.
- Document the new parameters in `README.md` § MCP Tools Reference and the four
  translated READMEs; bump `package.json` version.

## Capabilities

### New Capabilities
- `time-scoped-recall`: `recall` and `search` accept `after`/`before` bounds on a
  memory's creation time, pushed into the vector and fulltext stores so `limit` counts
  matching memories within the window rather than being spent on out-of-range
  candidates before filtering runs.

### Modified Capabilities

## Impact

- Affected code: `src/domain/types.ts` (`RecallFilter`), `src/domain/schemas.ts`
  (`RecallInputSchema`, `SearchInputSchema`), `src/tools/schemas.ts`,
  `src/tools/index.ts` (`handleRecall`, `handleSearch`), `src/storage/qdrant.ts`
  (`search`, `ensureCollection`), `src/storage/sqlite.ts` (`fullTextSearch`),
  `src/search/index.ts` (defensive re-check plumbing if centralized in
  `buildSearchResults`), plus co-located tests.
- Behavior: unfiltered `recall`/`search` calls are unchanged (filter omitted entirely
  when neither `after` nor `before` is present, matching the existing `type`/`tags`
  convention). Filtered calls narrow the candidate pool at the store, so `limit` counts
  matching, in-window memories.
- Storage: no schema change on either store — `created_at` already exists on every row
  and every Qdrant point. The only new Qdrant artifact is a payload index (`datetime`
  type on `created_at`), which is additive and does not require re-upserting points.
- Docs: README ×5, `.env.example` untouched (no new env vars), `CLAUDE.md`'s MCP
  surface lists untouched (no new tool or resource — only new optional parameters on
  existing tools), version bump.
- Depends on: `push-down-recall-filters` (the filter push-down pattern and
  `RecallFilter` plumbing this change extends). Related but explicitly deferred:
  point-in-time content reconstruction via `memory_revisions` (see Why and Design §
  Non-Goals) — a candidate follow-up change once this filter shape has shipped.
