## 1. Config schema

- [x] 1.1 Add `consolidation` to the Zod config schema (`src/config/index.ts`, near the
  `deduplication` block at line 146): `enabled` (default `true`), `similarity_threshold`
  (default `0.9`, min/max `[0,1]`), `neighbor_top_k` (default `20`, positive int),
  `max_scan_per_call` (default `500`, positive int).
- [x] 1.2 No new env vars — `.env.example` and `AGENTS.md`'s "Config vs. environment"
  section need no changes (same reasoning as `add-composite-recall-ranking` task 1.2:
  neither documents individual `config.json` fields for `search.*`/`deduplication.*`
  today).

## 2. Domain types

- [x] 2.1 Extend `LifecycleAuditDetails.action` (`src/domain/types.ts:200`) with
  `'consolidate'` and add an optional `merged_into?: string` field (documented like the
  existing `source_revision?: number` field at line 205) so a merge-driven `ARCHIVE`
  audit entry names its target and is distinguishable from `review`'s ordinary
  `ARCHIVE`/`action: 'archive'` entries. Verify no exhaustive `switch`/type-narrowing
  over `LifecycleAuditDetails.action` exists that this would break (none found as of
  this proposal — recheck at implementation time).

## 3. Qdrant neighbor discovery

- [x] 3.1 Add `QdrantStore.findNeighborsById(namespace, collection, pointId, topK,
  minScore)` (`src/storage/qdrant.ts`, alongside `search`/`searchSimilar` at lines
  160-270): calls `client.query(name, { query: pointId, limit: topK + 1, filter: {
  must: [{ key: 'namespace', match: { value: namespace } }] }, score_threshold:
  minScore, with_payload: false })`, requesting one extra result and filtering the
  query point's own id out of the response (Qdrant's Query API returns the query point
  itself at score 1.0 when querying by id). Same `isNotFoundError` handling as
  `searchSimilar` (a collection never written to yields `[]`, not a thrown error).
- [x] 3.2 Route through `executeWithBreaker` like every other `QdrantStore` method that
  calls the client.

## 4. The consolidate tool

- [x] 4.1 Schema: `ConsolidateInputSchema` in `src/domain/schemas.ts` (model on
  `ReviewInputSchema`'s discriminated shape) — `action: 'list' | 'merge'`; for `list`:
  `namespace` (default `global`), `collection` (default `general`), `cursor`,
  `min_cluster_size` (default `2`); for `merge`: `namespace`, `collection`,
  `target_id` (UUID), `source_ids` (array of UUIDs, min length 1, `target_id` must not
  appear in `source_ids` — Zod `.refine`).
- [x] 4.2 Tool metadata entry in `src/tools/schemas.ts` (append after `repair`, mirror
  the `review` entry's JSON-Schema shape at lines 170-186).
- [x] 4.3 Handler `handleConsolidate` in `src/tools/index.ts`, wired into `dispatch`'s
  switch (line 114-131) as `case 'consolidate': return handleConsolidate(...)`.
- [x] 4.4 `list`: page through `sqlite.listMemories(namespace, config.consolidation
  .max_scan_per_call, cursor)` scoped to `collection` (or add a
  `listMemoriesInCollection` cursor variant if the existing one at
  `src/storage/sqlite.ts:682` doesn't already support paging the way `list` needs);
  for each memory call `qdrant.findNeighborsById` with `config.consolidation
  .neighbor_top_k`/`similarity_threshold`; build clusters via union-find over the edges
  found within the scanned page; drop clusters below `min_cluster_size`; compute
  `suggested_target` (max `importance`, tie-break `access_count` then `updated_at`);
  return `{ clusters: [...], cursor }` with the same cursor semantics `review list`
  uses (`src/tools/index.ts:296-300`).
- [x] 4.5 `merge`: load `target_id` and every `source_ids` entry via
  `sqlite.getMemoryById`; reject with `INVALID_INPUT` if any id is missing (and not
  already archived — see next point), or if any resolved memory's `namespace`/
  `collection` differs from the target's; reject already-archived sources up front via
  `getArchiveByMemoryId` by excluding them from the merge set rather than failing the
  whole call (idempotent retry — see design.md). Union tags, `importance = max(...)`,
  update `merged_from` (comma-append per design.md) via `storage.updateMemory` (no
  `newVector`). Then, per remaining source: `sqlite.archiveMemory` + `storage
  .deleteMemory`, wrapped the same way `review`'s `archive` action is (roll back the
  archive row if delete fails), audited `ARCHIVE` with `action: 'consolidate'`,
  `merged_into: target_id`; collect per-source success/failure. Return `{ target_id,
  merged: string[], failed: string[] }`.
- [x] 4.6 `ctx.metrics.setGauge('bhgbrain_memory_count', ...)` update after `merge`,
  matching the pattern `review`'s `archive`/`restore` actions already follow
  (`src/tools/index.ts:390`, `453`).

## 5. Tests

- [x] 5.1 `findNeighborsById`: returns neighbors ≥ threshold excluding self; empty
  array for a never-written collection (no thrown error).
- [x] 5.2 `list`: clusters memories connected by a ≥-threshold edge within one scanned
  page; respects `min_cluster_size`; `suggested_target` picks the expected member
  (importance, then access_count, then recency) under a constructed tie scenario;
  pagination cursor advances and eventually returns `null`/empty.
- [x] 5.3 `merge`: happy path — tags unioned, importance maxed, `merged_from` set (both
  single-source exact-id and multi-source comma-joined cases); sources archived
  (vector removed, row in `archived_memories`); `ARCHIVE` audit entries carry
  `action: 'consolidate'` and `merged_into`.
- [x] 5.4 `merge` rejects: `target_id` inside `source_ids`; mixed-collection input;
  unknown id. Idempotent retry: re-`merge`-ing a `source_ids` list that includes an
  already-archived id succeeds for the rest and skips (not fails on) the archived one.
- [x] 5.5 `merge` partial failure: simulate a mid-loop `deleteMemory` throw (mock) and
  assert `merged`/`failed` both populate correctly and no source is left both archived
  and un-deleted (or vice versa).
- [x] 5.6 Config: `consolidation.enabled: false` — decide and test the handler's
  behavior when disabled (reject with a clear error, e.g. `INVALID_INPUT`, rather than
  silently running); defaults load and validate via the Zod schema.

## 6. Docs (MCP surface change — full sync required)

- [x] 6.1 Add `consolidate` to `CLAUDE.md`'s canonical MCP tools list (currently:
  `remember`, `recall`, `forget`, `search`, `tag`, `collections`, `category`, `backup`,
  `bootstrap`, `import`, `repair`, `revisions`, `review` — already up to date through
  `review`, so this task is purely additive, not a reconciliation).
- [x] 6.2 Add a `### consolidate` section to `README.md`'s § MCP Tools Reference
  (mirror the `review` section's structure: input table, output examples per action,
  prose describing the archive-transition reuse and the human-approval-only merge
  path), then propagate the same section into `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md`.
- [x] 6.3 Bump `package.json` `version` (currently `1.11.0`).

## 7. Validation

- [x] 7.1 `npm run lint` (tsc --noEmit + eslint, no `any` casts).
- [x] 7.2 `npm test` — full suite green, including the new tests from section 5.
