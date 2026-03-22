## 1. Collection-scoped storage and query helpers

- [ ] 1.1 Add SQLite helpers for checksum lookup by `(namespace, collection, checksum)` and for listing memories directly by collection with pagination support.
- [ ] 1.2 Extend vector search helpers so omitted-collection retrieval can enumerate namespace collections and merge candidates without falling back to `general`.

## 2. Service and resource behavior

- [ ] 2.1 Update search and recall flows so omitted-collection semantic, fulltext, and hybrid retrieval all use the same namespace-wide scope.
- [ ] 2.2 Update exact dedup in the write pipeline and `collection://{name}` resource handling to respect collection-scoped behavior and complete pagination.

## 3. Validation

- [ ] 3.1 Add regression tests for omitted-collection semantic/hybrid search, cross-collection exact dedup, and collection resource completeness.
- [ ] 3.2 Run `npm run lint`, `npm test`, and `npm run build` to verify collection-scope behavior end to end.
