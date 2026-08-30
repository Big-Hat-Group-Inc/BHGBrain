## 1. Collection-scoped storage and query helpers

- [x] 1.1 Add SQLite helpers for checksum lookup by `(namespace, collection, checksum)` and for listing memories directly by collection with pagination support. _(impl 2026-06-05: `getMemoryByChecksum(..., collection?)` + new `listMemoriesInCollection(namespace, collection, limit, cursor?)`, `src/storage/sqlite.ts`.)_
- [x] 1.2 Extend vector search helpers so omitted-collection retrieval can enumerate namespace collections and merge candidates without falling back to `general`. _(`QdrantStore.search` fans out over all `bhgbrain_<namespace>_*` collections and merges top-K when no collection is given, `src/storage/qdrant.ts`.)_

## 2. Service and resource behavior

- [x] 2.1 Update search and recall flows so omitted-collection semantic, fulltext, and hybrid retrieval all use the same namespace-wide scope. _(qdrant fan-out covers semantic/hybrid; fulltext already honored an optional collection.)_
- [x] 2.2 Update exact dedup in the write pipeline and `collection://{name}` resource handling to respect collection-scoped behavior and complete pagination. _(pipeline passes `input.collection` to exact dedup, `src/pipeline/index.ts`; `collection://{name}` now namespace-scoped + cursor-paginated, `src/resources/index.ts`.)_

## 3. Validation

- [x] 3.1 Add regression tests for omitted-collection semantic/hybrid search, cross-collection exact dedup, and collection resource completeness. _(2026-06-05: cross-collection exact dedup, `listMemoriesInCollection` scoping, and `collection://` namespace-scoping/pagination in `src/storage/sqlite.test.ts` + `src/resources/index.test.ts`; 2026-06-06: added `src/storage/qdrant.test.ts` covering the omitted-collection Qdrant fan-out, no-collections→empty, and explicit-collection paths via an injected mock client.)_
- [x] 3.2 Run `npm run lint`, `npm test`, and `npm run build` to verify collection-scope behavior end to end. _(2026-06-06: lint clean, 259 tests pass, build OK.)_
