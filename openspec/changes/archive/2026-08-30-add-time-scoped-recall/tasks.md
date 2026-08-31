## 1. Types and validation

- [x] 1.1 Extend `RecallFilter` (`src/domain/types.ts:23`) with `after?: string` /
  `before?: string`, updating the interface's doc comment to describe the new fields
  alongside the existing `type`/`tags` description.
- [x] 1.2 Add `after: z.string().datetime().optional()` / `before:
  z.string().datetime().optional()` to `RecallInputSchema`
  (`src/domain/schemas.ts:38-46`), plus a `.refine()` rejecting `after > before` (mirror
  the cross-field style of `RevisionsInputSchema`'s refine, `src/domain/schemas.ts:93-96`).
- [x] 1.3 Add the same two fields + refine to `SearchInputSchema`
  (`src/domain/schemas.ts:52-62`).
- [x] 1.4 Add `after`/`before` to the `recall` and `search` JSON schemas
  (`src/tools/schemas.ts`, `recall` block at line 23, `search` block at line 53):
  `{ type: 'string', format: 'date-time', description: '...' }`, documenting that
  bounds apply to `created_at` and are inclusive.

## 2. Qdrant push-down

- [x] 2.1 In `QdrantStore.search` (`src/storage/qdrant.ts:160-189`), append `{ key:
  'created_at', range: { gte: filters?.after, lte: filters?.before } }` to the `must`
  clause only when `filters?.after` or `filters?.before` is present — omitted entirely
  otherwise so unfiltered calls are unchanged. Verify against the client's
  `DatetimeRange` type (`node_modules/@qdrant/js-client-rest/dist/types/openapi/generated_schema.d.ts`,
  `FieldCondition.range: RangeInterface = Range | DatetimeRange`) that string bounds
  are accepted without a cast.
- [x] 2.2 Add a `datetime` payload index on `created_at` in `ensureCollection`
  (`src/storage/qdrant.ts:51-90`), ensured unconditionally (same pattern as
  `ensureDeviceIdIndex`, `:92-104`) so pre-existing collections pick it up
  retroactively; tolerate "already exists" the same way `ensureDeviceIdIndex` does.

## 3. SQLite push-down

- [x] 3.1 In `SqliteStore.fullTextSearch` (`src/storage/sqlite.ts:726-776`), append
  `m.created_at >= ?` / `m.created_at <= ?` predicates to `conditions` (alongside the
  existing `type`/`tags` predicates at `:749-763`) when `filter?.after`/`filter?.before`
  are present, pushing bound values onto `params` in the same relative order as the
  predicates so placeholders line up.

## 4. Tool wiring

- [x] 4.1 `handleRecall` (`src/tools/index.ts:156-205`): extend the existing filter
  construction (`:166-168`) to include `after`/`before` in the "build a filter only
  when something was actually requested" condition, and extend the defensive
  post-retrieval re-check (`:186-195`) to also verify `r.created_at` against the
  requested bounds, continuing to increment `recall_zero_after_filter` on any removal.
- [x] 4.2 `handleSearch` (`src/tools/index.ts:224-237`): replace the hardcoded
  `undefined` filter argument with a `RecallFilter` built from `after`/`before` when
  either is present (still `undefined` otherwise — `search` has no `type`/`tags`
  parameters and this change does not add them). Add a defensive post-retrieval
  re-check against `created_at` mirroring `handleRecall`'s, incrementing a new
  `search_zero_after_filter` counter on removal.
- [x] 4.3 Confirm `SearchService.search`'s existing `filter?: RecallFilter` parameter
  (`src/search/index.ts:82-97`) requires no signature change — it already threads the
  object opaquely to the stores; only its contents grow.

## 5. Tests

- [x] 5.1 `src/storage/qdrant.test.ts`: assert the `must` clause shape (a `range`
  condition on `created_at` with the expected `gte`/`lte`) via the mocked client, for
  `after`-only, `before`-only, and both-bounds cases; assert no `created_at` clause is
  added when neither bound is passed.
- [x] 5.2 `src/storage/qdrant.test.ts`: assert `ensureCollection` creates the
  `created_at` `datetime` index, including the retroactive (already-existing
  collection) path.
- [x] 5.3 `src/storage/sqlite.test.ts`: assert `fullTextSearch` excludes memories
  outside an `after`/`before` window and includes ones inside it, including boundary
  (exactly-equal-to-bound, inclusive) cases.
- [x] 5.4 `src/tools/index.test.ts`: filtered `recall` returns `limit` in-window
  matches when enough exist beyond the unfiltered top-`limit` (the starvation
  regression case, mirroring `push-down-recall-filters`' existing `type`/`tags` test),
  for both semantic (`recall`) and hybrid/fulltext (`search`) paths.
- [x] 5.5 `src/tools/index.test.ts`: `search` with `after`/`before` builds and passes a
  filter (currently always `undefined` — assert the call now carries one when bounds
  are given, and still `undefined` when they are not).
- [x] 5.6 `src/tools/index.test.ts`: `search_zero_after_filter` increments on defensive
  re-check removal in `handleSearch`, does not increment when the store already
  returned only in-window results (mirror the existing
  `recall_zero_after_filter` tests at `src/tools/index.test.ts:777-797`).
- [x] 5.7 `src/domain/schemas.ts` validation tests (or co-located): `after > before` is
  rejected on both `RecallInputSchema` and `SearchInputSchema`; a non-ISO-8601 string
  is rejected; `after`-only and `before`-only pass.

## 6. Docs and validation

- [x] 6.1 Update `README.md` § MCP Tools Reference for `recall` (`README.md:2363-2400`)
  and `search` (`README.md:2427-2442`): document `after`/`before`, that they filter on
  `created_at` (not `updated_at`), that bounds are inclusive ISO 8601 timestamps, and
  that they are pushed into the store the same way `type`/`tags` already are for
  `recall`. Add both new counters (`recall_zero_after_filter`'s extended scope,
  `search_zero_after_filter`) to the metrics table (`README.md:1924`).
- [x] 6.2 Apply the same documentation updates to `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md`, keeping section structure aligned with
  `README.md`.
- [x] 6.3 Bump `package.json` `version` (currently `1.11.0`) for the user-visible
  parameter additions.
- [x] 6.4 Run `npm run lint` (`tsc --noEmit` + `eslint src`) and `npm test`; both must
  pass before this change is considered complete.
