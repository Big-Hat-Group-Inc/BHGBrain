## Why

The only edge between memories today is `merged_from` — a single, implicit lineage
pointer set exclusively by the write pipeline's UPDATE path
(`src/pipeline/index.ts:228`, `src/domain/types.ts:56`, column at
`src/storage/sqlite.ts:192`) when dedup decides one memory replaces another. It is not
a general relationship: it cannot be created directly, cannot express anything other
than "replaced by," and is never read back at recall or search time — `recall`
(`src/tools/index.ts:156`) and `search` (`src/tools/index.ts:224`) each return an
unrelated flat list scored independently.

Real memory stores accumulate structure that a flat list can't express: a note that
refines an earlier one without fully replacing it, two memories that contradict each
other and need a human or a future contradiction-detector to resolve, a chain of
decisions that only make sense in sequence, or several memories about the same person
or project. None of that is capturable today short of repeating it in prose inside
`content` and hoping fulltext search reunites the pieces later.

`openspec/changes/add-composite-recall-ranking` improved *how* individual memories are
ranked; this proposal improves *what shape* the memory store is — turning the flat pile
into a graph with a small, fixed vocabulary of typed edges, discoverable through one
new tool and one opt-in recall parameter.

## What Changes

- Add a `memory_links` SQLite table: directed edges `(from_id, to_id, relation)` with
  `relation` constrained to five values — `refines`, `contradicts`, `derived_from`,
  `about_same_entity`, `follows` — namespace-scoped, deduplicated on
  `(from_id, to_id, relation)`.
- Add a `relate` MCP tool with three actions:
  - `add` — create a typed edge between two memories (idempotent: re-adding the same
    edge returns the existing one rather than erroring).
  - `list` — list a memory's edges, either direction, optionally filtered by relation.
  - `remove` — delete a specific edge.
- Extend the `recall` tool with an opt-in `follow_links: boolean` (default `false`)
  parameter: when set, each returned memory's one-hop neighbors (both directions, all
  relations) are appended to the result set, marked with `linked_from`, `link_relation`,
  and `link_direction` so a client can tell an expanded neighbor from a directly
  relevant hit. Bounded to a single hop and to a fixed number of appended neighbors —
  no multi-hop graph traversal, per the brainstorm's own scope note.
- Cascade-delete a memory's edges when the memory itself is deleted (`forget`, and the
  `review` tool's `archive` action, which also calls the same deletion path) so links
  never dangle on a missing memory id.
- Register schema/handler; update `CLAUDE.md`'s canonical tool list, README ×5, bump
  `package.json` version.

## Capabilities

### New Capabilities
- `memory-links`: Memories can be connected by typed, directed edges
  (`refines`/`contradicts`/`derived_from`/`about_same_entity`/`follows`), created and
  inspected via a `relate` tool, and optionally surfaced as one-hop neighbors during
  `recall`.

### Modified Capabilities

## Impact

- Affected code: `src/storage/sqlite.ts` (new table + CRUD methods,
  `deleteMemory` cascade), `src/domain/types.ts` (`MemoryLinkRecord`,
  `MemoryLinkRelation`, `SearchResult` link fields), `src/domain/schemas.ts`
  (`RelateInputSchema`, `RecallInputSchema.follow_links`), `src/tools/schemas.ts`
  (`relate` tool JSON schema, `recall`'s `follow_links` param), `src/tools/index.ts`
  (`handleRelate`, `handleRecall` expansion), tests.
- MCP surface grows by one tool (`relate`) and one `recall` parameter
  (`follow_links`) → `CLAUDE.md` canonical list + README ×5 sync in the same change
  (repo rule).
- No new config, no new env vars, no schema migration beyond a brand-new
  `CREATE TABLE IF NOT EXISTS` (existing databases pick it up on next startup with no
  `ALTER TABLE` step, unlike columns added to `memories`).
- Behavior for existing tools is unchanged unless a caller opts into
  `follow_links: true`; `merged_from` lineage is untouched and not migrated into
  `memory_links` (different concept: automatic replacement pointer vs. caller-declared
  typed edge).
- Foundational for, but does not implement, two brainstormed follow-ons: v2
  auto-tagging's entity graph (`codeaudit/storagefeaturebrainstorm.md` § 2.3, "a
  normalized `entities` table → ... graph edges") could emit `about_same_entity` edges
  automatically, and semantic contradiction detection (§ 2.4) could route a detected
  contradiction into a `contradicts` edge instead of (or alongside) an outright
  DELETE+replace. Neither is built here; `relate` only exposes the caller-driven path.
