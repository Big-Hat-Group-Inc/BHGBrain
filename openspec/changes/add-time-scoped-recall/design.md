## Context

`recall` and `search` both bottom out in `SearchService.search`
(`src/search/index.ts:82`), which already threads an optional `filter?: RecallFilter`
(`src/domain/types.ts:23`) into all three mode implementations
(`semanticSearch`/`fulltextSearch`/`hybridSearch`, `src/search/index.ts:97,142,175,198`)
and down into `QdrantStore.search` (`src/storage/qdrant.ts:160`) and
`SqliteStore.fullTextSearch` (`src/storage/sqlite.ts:726`) — this is the exact plumbing
`push-down-recall-filters` built for `type`/`tags`. `handleRecall`
(`src/tools/index.ts:156`) already constructs this filter conditionally and only when
requested; `handleSearch` (`src/tools/index.ts:224`) currently hardcodes the filter
argument to `undefined` — `search` has never had a pushed-down filter.

`created_at` is already present, unconditionally, on both sides of the store:

- SQLite: `memories.created_at TEXT NOT NULL` (`src/storage/sqlite.ts:198`), ISO 8601,
  covered by `idx_memories_created ON memories(created_at DESC)`
  (`src/storage/sqlite.ts:209`).
- Qdrant: `toQdrantPayload` writes `created_at: mem.created_at` unmodified —
  still an ISO 8601 string, unlike `expires_at`, which the same function converts to
  Unix seconds for its own range filter (`src/storage/index.ts:819,821`;
  `src/storage/qdrant.ts:186`, the existing `expires_at` `range: { gte: ... }` clause
  in the always-applied "not expired" `should` block).

The `@qdrant/js-client-rest` types (verified in
`node_modules/@qdrant/js-client-rest/dist/types/openapi/generated_schema.d.ts:1440`)
define `FieldCondition.range` as `RangeInterface = Range | DatetimeRange`, where
`DatetimeRange` (`:1465`) takes `string` bounds for `lt`/`gt`/`gte`/`lte` — Qdrant's
native RFC 3339 datetime range filtering (available since server 1.8, below this
repo's server floor of 1.10). `PayloadSchemaType` (`:1064`) includes `"datetime"` as a
valid index type, used the same way `expires_at` already gets an `integer` index
(`src/storage/qdrant.ts:78-81`).

## Goals / Non-Goals

Goals:
- `after`/`before` (ISO 8601, inclusive bounds) on both `recall` and `search`,
  filtering by `created_at`.
- Push-down as the primary mechanism (store-level), matching `type`/`tags`'s existing
  pattern — `limit` counts in-window matches, not global top-K minus filtered rows.
- No storage migration: `created_at` already exists on every row and every point.

Non-Goals:
- **No `as_of` / point-in-time content reconstruction.** The brainstorm note this
  proposal originates from floated `as_of` using the revision table. Investigating it
  surfaced more than "small effort" worth of new problems:
  1. **Ranking/content mismatch.** Semantic and hybrid modes rank by the *current*
     embedding (there is no historical embedding for a past revision — embeddings are
     never computed for `memory_revisions` rows). An `as_of` recall could filter out
     memories created after the cutoff and swap in historical `content` from
     `memory_revisions` for the rest, but the ranking driving which memories surface
     would still reflect today's content, not the content being displayed. That
     inconsistency needs its own design (e.g., is it acceptable, documented, or does it
     require re-ranking against something else?).
  2. **Partial versioning.** `memory_revisions` versions `content` only
     (`src/storage/sqlite.ts:262-270`) — `summary` and `tags` are not versioned, so an
     "as of" result would show today's summary/tags next to yesterday's content.
  3. **Reconstruction algorithm is per-candidate, not push-down.** Unlike `after`/
     `before`, which the stores can filter on directly, "content as of T" requires a
     `memory_revisions` lookup per surviving candidate
     (`SELECT content FROM memory_revisions WHERE memory_id = ? AND updated_at > ?
     ORDER BY updated_at ASC LIMIT 1`, falling back to the live row if none exists) —
     doable, but a second I/O round-trip per result rather than a single filter clause.

  None of these are unsolvable, but each is a real design decision, not a mechanical
  extension of the `type`/`tags` push-down pattern. Given the "small effort" framing of
  the originating idea, `as_of` is deferred to a follow-up change that can take it on
  as its own problem, grounded in `surface-memory-revision-history`'s
  `memory_revisions` schema.
- No change to `type`/`tags` semantics or `min_score` handling (untouched by this
  change).
- No new config; `after`/`before` are per-call parameters, not operator settings.

## Decisions

- **Filter shape**: extend `RecallFilter` with `after?: string; before?: string`
  (ISO 8601). Both optional and independent — `after` alone means "no upper bound",
  `before` alone means "no lower bound", matching typical range-query ergonomics.
- **Validation**: `RecallInputSchema`/`SearchInputSchema` gain
  `after: z.string().datetime().optional()` / `before: z.string().datetime().optional()`
  plus a `.refine()` rejecting `after > before`, the same refinement style already used
  by `RevisionsInputSchema` (`src/domain/schemas.ts:93-96`) for its
  action/revision cross-field check.
- **Qdrant push-down**: add `{ key: 'created_at', range: { gte: filters.after, lte:
  filters.before } }` to the `must` clause in `QdrantStore.search`
  (`src/storage/qdrant.ts:171-182`), only when `after`/`before` are present — omitted
  entirely otherwise, so unfiltered calls are byte-identical to today. No payload
  migration: `created_at` is already an ISO string on every point.
- **Qdrant index**: add a `datetime` payload index on `created_at` in `ensureCollection`
  (`src/storage/qdrant.ts:51-90`), ensured unconditionally (same pattern as
  `ensureDeviceIdIndex`, `:92-104`) so collections created before this change still get
  it retroactively. Unindexed range filtering would still work (Qdrant filters on
  unindexed fields, just linearly), so this is a performance addition, not a
  correctness dependency — filtering is correct even mid-backfill.
- **SQLite push-down**: add `m.created_at >= ?` / `m.created_at <= ?` predicates to
  `fullTextSearch`'s `conditions` array (`src/storage/sqlite.ts:744-763`, alongside the
  existing `type`/`tags` predicates), using the same ISO 8601 lexicographic comparison
  the column's existing index already supports.
- **`search` gains its first filter**: `handleSearch` (`src/tools/index.ts:224-237`)
  currently passes `undefined` for `filter` unconditionally. This change builds a
  `RecallFilter` there (containing only `after`/`before` — `search` still has no
  `type`/`tags` parameters, out of scope here) when either bound is present, mirroring
  `handleRecall`'s existing conditional-construction pattern
  (`src/tools/index.ts:166-168`).
  and undergo the same defensive re-check on `created_at`, incrementing a new
  `search_zero_after_filter` counter (parallel to `recall`'s existing
  `recall_zero_after_filter`, kept as a separate metric since it is scoped to a
  different tool and, unlike `recall`, `search`'s pre-existing behavior had no
  post-filter to begin with).
- **Defensive re-check, but lower risk than `type`/`tags`**: `push-down-recall-filters`
  added its re-check because Qdrant points written before `type`/`tags` existed in the
  payload would silently mismatch a filter. `created_at` has no equivalent history — it
  has been in the payload since `toQdrantPayload` was introduced — so there is no
  "old points missing the field" risk class here. The re-check is retained anyway for
  parity and as insurance against any other drift (e.g. a future payload-shape change),
  but it is not covering a known gap the way the `type`/`tags` one was.
- **Bound interpretation**: `after`/`before` compare against `created_at`, not
  `updated_at`. `created_at` is when the memory was first recorded — the natural
  anchor for "what did we decide last week" — while `updated_at` drives the
  *unrelated* composite-ranking recency decay (`add-composite-recall-ranking`, "young
  again" on UPDATE). Reusing `updated_at` here would conflate two different questions
  ("when did this happen" vs. "how fresh is this signal") that the codebase already
  keeps separate.

## Risks / Trade-offs

- **Timezone/format footguns**: `z.string().datetime()` accepts RFC 3339 with a `Z` or
  offset suffix; a caller passing a bare date (`"2026-08-01"`) or a non-UTC string
  without an offset will get a validation error rather than silently misinterpreted
  results. Documented in the tool description.
- **Empty-window results are indistinguishable from "nothing relevant"** in exactly
  the way `push-down-recall-filters`' Why section already flags for `type`/`tags` — a
  narrow or inverted (`after` after `before`, caught by validation) window can
  legitimately return zero matches. The defensive-recheck counters give operators a
  signal if this is push-down drift rather than a genuinely empty window, but nothing
  distinguishes "correctly empty" from "query too narrow" at the API level; that is
  consistent with existing `min_score`/`type`/`tags` behavior, not a regression.
- **Two independent counters** (`recall_zero_after_filter` reused, `search_zero_after_filter`
  added) instead of one shared name: slightly more surface in the metrics table, but
  keeps each tool's dashboard signal attributable without inferring which tool a
  shared counter's increments came from.
