## Context

`add-review-and-archive-recall` closed the read side of the tiered-lifecycle write
mechanics; this proposal does the analogous thing for structure: `merged_from` is a
write-side-only, single-purpose pointer, and this change gives callers a general,
readable, directly-authored edge type alongside it. It deliberately does not touch
`merged_from` — that field means "the write pipeline decided this memory replaces that
one," a narrower and automatic concept that would be muddied by folding it into a
caller-authored relation vocabulary.

`recall` (`src/tools/index.ts:156`) already has an established pattern for
"push a predicate down, then defensively re-check, then reshape before returning" (see
`push-down-recall-filters`'s `type`/`tags` handling at `src/tools/index.ts:166-195`) and
for appending a differently-sourced, differently-scored batch of results onto a normal
result list (`search`'s `include_archived`, `src/search/index.ts:117-129`, using a flat
placeholder `score: 0` and a boolean marker rather than pretending the appended entries
were ranked by relevance — `src/search/index.ts:42-51`). Link-following at recall reuses
both patterns rather than inventing a third.

## Goals / Non-Goals

Goals:
- A small, fixed, typed edge vocabulary sufficient for the brainstorm's five relation
  kinds, creatable/listable/removable through one new tool.
- Single-hop, opt-in neighbor expansion at `recall` time, bounded and clearly marked so
  it cannot silently balloon a response or be mistaken for a relevance-ranked hit.
- No dangling edges: deleting a memory removes its edges.

Non-Goals:
- No multi-hop graph traversal. The brainstorm explicitly calls this "likely overkill"
  even while endorsing single-hop expansion; this change bounds itself to one hop and
  leaves deeper traversal to a future change if the single-hop version proves useful.
- No relation-specific traversal semantics in `recall` (e.g. only walking `refines`
  edges, or walking them in a particular direction). `follow_links` surfaces all
  one-hop neighbors regardless of relation or direction, tagged with enough metadata
  (`link_relation`, `link_direction`) for a client to filter client-side. Modeling
  "refines edges only, and only in the direction that surfaces newer supersessions"
  would require per-relation traversal rules that add real design surface for a
  benefit better validated after the primitive itself ships.
- No automatic edge creation. `about_same_entity` and `contradicts` in particular are
  natural outputs of future auto-tagging/contradiction-detection work
  (`codeaudit/storagefeaturebrainstorm.md` §§ 2.3–2.4), but this change only exposes the
  caller-driven `relate` tool; nothing here infers edges from content.
- No edge weights, confidence scores, or expiry. An edge exists or it doesn't.
- No migration of existing `merged_from` pointers into `memory_links` rows.

## Decisions

- **New table, not a join through `memories`**: `memory_links(id, namespace, from_id,
  to_id, relation, created_at, created_by)`, `UNIQUE(from_id, to_id, relation)`,
  `relation` restricted by `CHECK` to the five brainstormed values. `namespace` is
  denormalized onto the row (redundant with the memories it points at) following the
  `memory_archive` precedent (`src/storage/sqlite.ts:272-283`, which also carries a
  redundant `namespace` column) so link listing/scoping never needs a join.
- **Directed edges, symmetric relations included**: all five relations are stored
  directionally (`from_id` → `to_id`), even `contradicts` and `about_same_entity`,
  which are conceptually symmetric. `relate list` and `recall`'s expansion both walk
  both directions, so symmetric relations behave symmetrically in practice without
  needing two rows or a nullable direction column. Directional storage keeps the schema
  and the `add`/`remove` contract uniform across all five relations instead of special
  -casing two of them.
- **`add` is idempotent, not error-on-duplicate**: re-adding an existing
  `(from_id, to_id, relation)` triple returns the existing row (`created: false`)
  instead of a `CONFLICT`. An edge either exists or it doesn't; there's no meaningful
  "second add" to reject, unlike `review`'s `archive` (where re-archiving *is* a
  meaningful conflict because it would double-transition a lifecycle state machine).
- **Self-links and cross-namespace links rejected**: `from_id === to_id` and
  `from_id`/`to_id` resolving to different namespaces both fail `INVALID_INPUT` at the
  handler (after fetching both memories, same as `review`'s existing
  `getMemoryById`-then-validate shape). Cross-collection links within the same
  namespace are allowed — collections are an organizational grouping, not an isolation
  boundary the way namespace is (`AGENTS.md` "Namespace Scoping").
- **No audit_log entries for `relate`**: `tag` (`src/tools/index.ts:239-263`), a
  comparable metadata-mutation tool, does not write to `audit_log` either. Adding a new
  `AuditOperation` variant (`RELATE`/`UNRELATE`) for a tool with three simple actions
  and full `relate list` visibility into current state is not proportionate scope; the
  edge table itself is the durable record, and `created_at`/`created_by` on each row
  cover "when and by whom" without a second log.
- **Cascade delete lives in `SqliteStore.deleteMemory`, not the tool layer**:
  `deleteMemory` (`src/storage/sqlite.ts:615-623`) already deletes the matching
  `memories_fts` row in the same method: `memory_links` cleanup (`from_id = ? OR
  to_id = ?`) is added there as one more per-table cleanup step, so both `forget` and
  `review`'s `archive` action (which calls `StorageManager.deleteMemory` after
  `archiveMemory`, `src/tools/index.ts:369-378`) get cascade cleanup for free without
  each tool handler re-implementing it.
- **`follow_links` expansion happens in `handleRecall`, not `SearchService`**:
  `recall`'s type/tags filtering and limit slicing already live entirely in
  `src/tools/index.ts:156-205`, not in `SearchService`; `follow_links` continues that
  precedent rather than threading a new parameter through `SearchService.search`'s
  five-parameter signature (`src/search/index.ts:82-98`) for a concern that is really
  "reshape the tool's own output," matching how `search`'s `include_archived`
  concatenation happens inside `SearchService` only because that tool's whole
  result-shaping already lives there.
- **Expansion runs on the final, limit-sliced result set** — after `filtered.slice(0,
  input.limit)` — not on the wider pre-slice candidate pool. This bounds the number of
  memories whose links get looked up to at most `input.limit` (≤ 20), keeping cost
  predictable regardless of how large `fetchLimit`'s over-fetch was.
- **Appended neighbors carry `score: 0`, an `archived`-style placeholder** (matching
  `archiveRecordToSearchResult`, `src/search/index.ts:42-51`) plus `linked_from`
  (origin memory id), `link_relation`, and `link_direction` (`'outgoing'` if the
  origin is `from_id`, `'incoming'` if the origin is `to_id`). Deduplicated against
  both the base result set and each other (a neighbor reachable from two different base
  results is returned once). Total appended neighbors capped at `input.limit` so a
  `follow_links: true` recall response is bounded to at most 2×`limit` entries.
  Neighbors already `archived` are skipped (matches `getMemoryById`'s default
  non-archived-only read; a link to a now-archived memory contributes nothing
  recallable).

## Risks / Trade-offs

- **Idempotent `add` hides typos**: adding the same pair with a different relation by
  mistake creates a second, different edge rather than erroring (only the exact triple
  is deduplicated). Accepted — `relate list` makes existing edges on a memory visible
  before adding another, and rejecting near-duplicates would require relation-aware
  business rules ("only one relation per pair") the brainstorm doesn't ask for.
- **Restore doesn't restore links**: `review`'s `restore` action creates a new memory
  with a new id (`src/tools/index.ts:407`), so a memory's edges — cascade-deleted when
  it was archived — are not and cannot be reattached to the restored stub. Accepted and
  documented; recreating edges against a fresh id would require the archive record to
  retain link data it currently doesn't, out of scope here.
- **`follow_links` cost**: up to `limit` extra `listMemoryLinks` + `getMemoryById`
  calls per recall. Bounded and cheap (indexed single-row lookups per hop), but not
  free; default `false` keeps every existing caller's cost unchanged.
- **Five fixed relations, no extensibility hook**: a caller wanting a sixth relation
  (e.g. `supersedes` distinct from `refines`) has no way to add one short of a schema
  change. Accepted for v1 — an open-ended relation string would trade a useful `CHECK`
  constraint and predictable `recall` output for flexibility nothing in the brainstorm
  asks for yet.
