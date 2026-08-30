## 1. Real Fulltext Lexical Ranking

- [x] 1.1 Replace the constant `${terms.length} as rank` / `rank: -terms.length` in `fullTextSearch` (`src/storage/sqlite.ts:571,577`) with a real per-row lexical relevance score (e.g. FTS5 `bm25(memories_fts)` / `rank`, or a deterministic term-frequency count when FTS5 is unavailable in the sql.js build). _(impl 2026-06-05: `memories_fts` is a plain table — implemented the weighted term-frequency fallback with `SqliteStore.countOccurrences`.)_
- [x] 1.2 Order fulltext results by descending relevance so the SQL return order reflects relevance, and normalize the score consistently for the search layer. _(over-fetch a bounded candidate pool, score in JS, sort desc, slice to limit.)_
- [x] 1.3 Update `fulltextSearch` and `hybridSearch` (`src/search/index.ts`) so the fulltext RRF component ranks by real relevance instead of insertion order. _(no change needed in search layer: RRF already ranks by array position, which is now relevance-ordered.)_
- [x] 1.4 Add/adjust tests asserting that distinct rows receive distinct relevance-ordered ranks and that hybrid ordering reflects fulltext relevance. _(`src/storage/sqlite.test.ts` "ranks by term-frequency relevance".)_

## 2. Namespace Scoping for Resources

- [x] 2.1 Make `collection://list` namespace-scoped: read namespace from `?namespace=` (default `config.defaults.namespace`) and pass it to `listCollections(namespace)`. _(`src/resources/index.ts`.)_
- [x] 2.2 Make `collection://{name}` namespace-scoped: default to `config.defaults.namespace` instead of hardcoding `'global'` (`src/resources/index.ts:234`), and query memories scoped to that namespace + collection. _(now uses `listMemoriesInCollection` with cursor pagination.)_
- [x] 2.3 Decide and implement category namespace behavior in `category://list` and `category://{name}` (`src/resources/index.ts:203-222`): either scope by namespace or explicitly document categories as global, matching the spec scenario. _(2026-06-05 decision = categories are intentionally global (no namespace column in the schema; shared policy context); 2026-06-06: documented explicitly with a `handleCategory` code comment contrasting it with the now-namespace-scoped `collection://`.)_
- [x] 2.4 Add tests proving `collection://`/`category://` reads do not return data from a non-default namespace unless an explicit `?namespace=` is supplied. _(`src/resources/index.test.ts` "collection resource scoping".)_

## 3. Observable Hybrid Embedding Degradation

- [x] 3.1 Replace the silent `catch { /* fall back to fulltext only */ }` in `hybridSearch` (`src/search/index.ts:125-127`) with a `warn`-level Pino log including the error and a `degraded: 'fulltext_only'` field (and/or a metric). _(emits `metrics.incCounter('search_embedding_degraded')` + `logger.warn({ event: 'embedding_degraded', degraded: 'fulltext_only' })`.)_
- [x] 3.2 Surface partiality to the caller (e.g. a `degraded` indicator on the hybrid search response) so a fulltext-only fallback is distinguishable from a healthy hybrid result. _(2026-06-06: `SearchService.search` takes an optional per-call `signal: { degraded? }` out-parameter set on fulltext-only fallback (no `SearchResult[]` contract break); the `search` tool returns `{ results, degraded }`, `src/tools/index.ts`. Tested in `src/search/index.test.ts`.)_
- [x] 3.3 Add a test that simulates an embedding outage in hybrid mode and asserts the log/signal is emitted and results are not silently identical to a healthy run. _(`src/search/index.test.ts` asserts metric + warn emitted and Qdrant not queried.)_

## 4. MCP structuredContent Delivery

- [x] 4.1 In the `CallTool` handler (`src/index.ts:104-114`), add `structuredContent: result` to successful, object-shaped tool results alongside the existing text block (retaining the text block for backward compatibility). _(`src/index.ts`.)_
- [x] 4.2 Add a test asserting that a successful tool call returns the MCP `structuredContent` field and that error envelopes still set `isError`. _(2026-06-06: extracted the response builder into `src/transport/mcp-response.ts` (`buildToolCallResponse`) and tested it in `src/transport/mcp-response.test.ts` — success→structuredContent, error→isError, array→neither.)_

## 5. Per-Tool Contract Tests

- [x] 5.1 Add table-driven contract tests asserting the `INVALID_INPUT` envelope for an unknown field and an out-of-bounds value on each of `recall`, `search`, `tag`, `category`, and `backup` (completing the partial original task 3.3). _(2026-06-06: `src/tools/index.test.ts` "tool input contracts" — 10 table-driven cases.)_

## 6. Validation

- [x] 6.1 Run `npm run lint`, `npm test`, and `npm run build`. _(2026-06-06: lint clean, 259 tests pass, build OK.)_
