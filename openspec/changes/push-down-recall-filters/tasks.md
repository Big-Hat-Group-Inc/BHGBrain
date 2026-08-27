## 1. Store-level filter support

- [x] 1.1 Extend `QdrantStore.search` (`src/storage/qdrant.ts`) with an optional
  `filter?: { type?: MemoryType; tags?: string[] }` parameter translated to a Qdrant
  `must` clause (`type` exact match, `tags` match-any), preserved across the
  namespace fan-out path.
- [x] 1.2 Extend `SqliteStore.fullTextSearch` (`src/storage/sqlite.ts`) with the same
  filter object as SQL predicates on the joined `memories` row (delimiter-aware tag
  matching against the serialized tags column).
- [x] 1.3 Plumb the filter through `SearchService.search`/`semanticSearch`/
  `fulltextSearch`/`hybridSearch` (`src/search/index.ts`) without changing existing
  callers' behavior when no filter is passed.

## 2. Recall uses push-down

- [x] 2.1 `handleRecall` (`src/tools/index.ts`) passes `type`/`tags` into the search
  call; over-fetch modestly (e.g. `limit * 2`, capped) so expired-row exclusion cannot
  starve the limit; keep a defensive post-retrieval re-check.
- [x] 2.2 Apply `min_score` to `semantic_score ?? score` and update the `recall` schema
  description (`src/tools/schemas.ts`) to state it is a cosine-similarity threshold.
- [x] 2.3 Add a guard test asserting recall's score threshold is applied to the cosine
  field, so a future mode change that breaks the calibration fails CI.

## 3. Observability

- [x] 3.1 Increment a `recall_zero_after_filter` counter when the defensive re-check
  removes results that the stores returned; cover with a test.

## 4. Tests and docs

- [x] 4.1 Tests: filtered recall returns `limit` matching results when enough matches
  exist beyond the unfiltered top-`limit` (the starvation regression case), for both
  type and tags filters, on semantic and fulltext paths.
- [x] 4.2 Test: Qdrant filter clause shape (type match, tags match-any) asserted via
  the mocked client.
- [x] 4.3 Update `README.md` § MCP Tools Reference (recall filter semantics, min_score
  meaning) and the four translated READMEs; bump `package.json` version.
- [x] 4.4 `npm run lint` and `npm test` pass.
