## 1. Schema and domain types

- [x] 1.1 Add `memory_links` to `SCHEMA_SQL` in `src/storage/sqlite.ts` (after the
  `embedding_state` table block, `src/storage/sqlite.ts:315-321`): `id INTEGER PRIMARY
  KEY AUTOINCREMENT`, `namespace TEXT NOT NULL`, `from_id TEXT NOT NULL`, `to_id TEXT
  NOT NULL`, `relation TEXT NOT NULL CHECK(relation IN ('refines','contradicts',
  'derived_from','about_same_entity','follows'))`, `created_at TEXT NOT NULL`,
  `created_by TEXT`, `UNIQUE(from_id, to_id, relation)`. Add `idx_memory_links_from`,
  `idx_memory_links_to`, `idx_memory_links_namespace` indexes. No `ensureMemoryColumns`
  entry needed — this is a brand-new table, not a column on `memories`, so
  `CREATE TABLE IF NOT EXISTS` alone covers existing databases on next startup.
- [x] 1.2 Add `MemoryLinkRelation` (the five-value union) and `MemoryLinkRecord`
  (`id: number`, `namespace: string`, `from_id: string`, `to_id: string`, `relation:
  MemoryLinkRelation`, `created_at: string`, `created_by: string | null`) to
  `src/domain/types.ts` near `ArchiveRecord` (`src/domain/types.ts:223`).
- [x] 1.3 Extend `SearchResult` (`src/domain/types.ts:84-108`) with optional
  `linked_from?: string`, `link_relation?: MemoryLinkRelation`, `link_direction?:
  'outgoing' | 'incoming'` — absent (not `false`/`null`) on every normal result, same
  convention as the existing `archived?: boolean` field (`src/domain/types.ts:107`).

## 2. Storage layer

- [x] 2.1 Add to the `SqliteStorage` interface (`src/storage/sqlite.ts:70`, near
  `getArchiveByMemoryId`/`insertRevision` at lines 130-133):
  `addMemoryLink(namespace: string, fromId: string, toId: string, relation:
  MemoryLinkRelation, createdBy: string | null): { record: MemoryLinkRecord; created:
  boolean }`, `listMemoryLinks(memoryId: string, options?: { relation?:
  MemoryLinkRelation }): Array<MemoryLinkRecord & { direction: 'outgoing' |
  'incoming' }>`, `removeMemoryLink(fromId: string, toId: string, relation:
  MemoryLinkRelation): boolean`.
- [x] 2.2 Implement `addMemoryLink`: `SELECT` first for an existing `(from_id, to_id,
  relation)` row; if found, return it with `created: false`. Otherwise `INSERT` and
  return the new row with `created: true`. Mirrors the read-then-write shape already
  used for archive lookups (`getArchiveByMemoryId`, `src/storage/sqlite.ts:1289-1300`)
  rather than relying on `INSERT OR IGNORE` + a second query.
- [x] 2.3 Implement `listMemoryLinks`: `SELECT * FROM memory_links WHERE from_id = ? OR
  to_id = ?` (plus `AND relation = ?` when `options.relation` is set), map each row to
  `direction: 'outgoing'` when `from_id === memoryId` else `'incoming'`.
- [x] 2.4 Implement `removeMemoryLink`: `DELETE FROM memory_links WHERE from_id = ? AND
  to_id = ? AND relation = ?`; return whether a row was actually deleted (mirrors the
  boolean-return convention of `deleteMemory`, `src/storage/sqlite.ts:615`).
- [x] 2.5 In `deleteMemory` (`src/storage/sqlite.ts:615-623`), add `DELETE FROM
  memory_links WHERE from_id = ? OR to_id = ?` alongside the existing `memories_fts`
  cleanup, so both `forget` and `review`'s `archive` action (which calls
  `StorageManager.deleteMemory` after `archiveMemory`,
  `src/tools/index.ts:369-378`) cascade-clean edges without each call site
  reimplementing it.

## 3. Domain schemas and MCP tool registration

- [x] 3.1 Add `RelateInputSchema` to `src/domain/schemas.ts` (near
  `ReviewInputSchema`, `src/domain/schemas.ts:98-112`): `action: z.enum(['add', 'list',
  'remove'])`, `from_id: z.string().uuid().optional()`, `to_id:
  z.string().uuid().optional()`, `relation:
  z.enum(['refines','contradicts','derived_from','about_same_entity','follows']).optional()`,
  `id: z.string().uuid().optional()` (the memory whose links to list, for `action:
  'list'`), `direction: z.enum(['from','to','both']).optional().default('both')` (list
  filter). `.strict().refine(...)`: `add`/`remove` require `from_id`, `to_id`, and
  `relation`, and `from_id !== to_id`; `list` requires `id`. Export `RelateInput` type
  alongside the other input types (`src/domain/schemas.ts:138-147`).
- [x] 3.2 Add `follow_links: z.boolean().optional().default(false)` to
  `RecallInputSchema` (`src/domain/schemas.ts:38-46`).
- [x] 3.3 Add the `relate` tool definition to `MCP_TOOL_DEFINITIONS` in
  `src/tools/schemas.ts` (after `review`, before `repair` — matching registration order
  in `src/tools/index.ts`'s `dispatch` switch, `src/tools/index.ts:113-130`): action
  enum, `from_id`/`to_id`/`relation`/`id`/`direction` properties with the same
  constraints as 3.1, `required: ['action']`, `additionalProperties: false`.
- [x] 3.4 Add `follow_links` to the `recall` tool's `inputSchema.properties` in
  `src/tools/schemas.ts` (`src/tools/schemas.ts:23-40`): `{ type: 'boolean',
  description: 'Also return each result's one-hop linked memories (relate tool
  edges, both directions, all relations), marked with linked_from/link_relation/
  link_direction. Default false.', default: false }`.

## 4. Tool handler

- [x] 4.1 Add `handleRelate` to `src/tools/index.ts` (near `handleReview`,
  `src/tools/index.ts:287`) and register it in `dispatch`'s switch
  (`src/tools/index.ts:113-130`, alongside `case 'review': return handleReview(...)`).
- [x] 4.2 `action: 'add'`: fetch both memories via `getMemoryById` (`notFound` if
  either is missing); `invalidInput` if `from_id === to_id` or the two memories'
  `namespace` values differ; set `logCtx.namespace` from the shared namespace; call
  `addMemoryLink`; return `{ id, namespace, from_id, to_id, relation, created_at,
  created }`.
- [x] 4.3 `action: 'remove'`: call `removeMemoryLink`; `notFound` if it returns `false`;
  otherwise return `{ removed: true, from_id, to_id, relation }`.
- [x] 4.4 `action: 'list'`: fetch the memory via `getMemoryById` (`notFound` if
  missing, using the archived-inclusive lookup so links on an about-to-be-archived
  memory remain listable); `logCtx.namespace` from it; call `listMemoryLinks` filtered
  by `direction` (post-filter the `'outgoing'`/`'incoming'` results client-side in the
  handler when `direction !== 'both'`, since the storage method always returns both);
  return `{ id, links: [...] }` with each entry `{ id, from_id, to_id, relation,
  direction, created_at, created_by }`.
- [x] 4.5 In `handleRecall` (`src/tools/index.ts:156-205`), after the existing
  `filtered.slice(0, input.limit)` computation: when `input.follow_links` is true,
  for each result in the sliced set call `listMemoryLinks(result.id)`, resolve the
  other-end memory via `getMemoryById` (skip if archived or already present as a base
  result or an already-appended neighbor), map to a `SearchResult` with `score: 0`,
  `linked_from` = the base result's id, `link_relation`, `link_direction`; append,
  capped at `input.limit` total appended entries; return the combined array (base
  results first, then appended neighbors) instead of the bare sliced array.

## 5. Tests

- [x] 5.1 `addMemoryLink`/`listMemoryLinks`/`removeMemoryLink` unit tests in
  `src/storage/sqlite.test.ts`: idempotent re-add returns `created: false` with the
  same row; `listMemoryLinks` returns correct `direction` for both ends of an edge and
  respects a `relation` filter; `removeMemoryLink` returns `false` for a non-existent
  edge.
- [x] 5.2 `deleteMemory` cascade test: creating a link then deleting either endpoint
  removes the `memory_links` row (query directly or via `relate list` on the surviving
  endpoint returning empty).
- [x] 5.3 `relate` tool tests in `src/tools/index.test.ts` (or a co-located
  `relate.test.ts` if the existing file groups by tool): `add` happy path and
  idempotent re-add; `add` rejects self-link and cross-namespace link with
  `INVALID_INPUT`; `add`/`remove`/`list` all `NOT_FOUND` on a missing memory id;
  `remove` on a non-existent edge is `NOT_FOUND`; `list` respects `direction` and
  `relation` filters.
- [x] 5.4 `recall` `follow_links` tests: default `false` leaves `recall` output
  byte-for-byte unchanged from before this change (no `linked_from` field appears
  anywhere); `true` appends one-hop neighbors with correct
  `linked_from`/`link_relation`/`link_direction`; a neighbor reachable from two base
  results appears once; total appended entries respect the `input.limit` cap; an
  archived neighbor is skipped.
- [x] 5.5 Regression: `review`'s `archive` action on a memory with existing links
  leaves no orphaned `memory_links` rows (extends the cascade test in 5.2 through the
  actual archive path rather than a direct `deleteMemory` call).

## 6. Docs (MCP surface change — full sync required)

- [x] 6.1 Update `CLAUDE.md`'s canonical tool list (`CLAUDE.md`, "MCP surface"
  section) to add `relate` to the `Registered:` line.
- [x] 6.2 Add a `### \`relate\`` section to `README.md`'s "MCP Tools Reference" (near
  the existing `revisions`/`review` sections, `README.md:2691`/`README.md:2738`)
  documenting the three actions, the five relations, idempotent `add`, and
  `recall`'s new `follow_links` parameter (documented alongside `recall`'s existing
  parameter table). Mirror the same additions into `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md` section-for-section.
- [x] 6.3 Bump `package.json` `version` (currently `1.11.0`).
- [x] 6.4 Run `npm run lint` and `npm test`; both must pass before this change is
  considered done. `npm run lint` is clean. `npm test` is clean except one
  pre-existing flake unrelated to this change:
  `src/transport/http.test.ts > returns health without auth and uses 200/503
  based on status` times out (5000ms) only under full-suite parallel load;
  it passes standalone (`npx vitest run src/transport/http.test.ts`, ~740ms).
  This file is untouched by add-memory-links.
