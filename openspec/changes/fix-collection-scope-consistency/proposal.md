## Why

Collection scoping is currently inconsistent across search, deduplication, and resource reads. When `collection` is omitted, fulltext search behaves namespace-wide while vector-backed search falls back to `general`; exact checksum dedup ignores collection boundaries; and `collection://{name}` can omit older matching memories because it truncates before filtering.

## What Changes

- Define one consistent collection-scope contract for `search`, `recall`, and deduplication.
- Require omitted-collection search behavior to remain namespace-wide across semantic, fulltext, and hybrid retrieval.
- Align exact deduplication scope with the chosen collection contract so write behavior matches read behavior.
- Define collection resource behavior to query collection-scoped results directly, with pagination instead of namespace truncation.
- Add regression coverage for omitted-collection search, cross-collection dedup, and collection resource completeness.

## Capabilities

### New Capabilities
- `collection-scope-consistency`: defines consistent namespace-versus-collection behavior across search, recall, deduplication, and collection resources.

### Modified Capabilities

## Impact

- Affected code: `src/search`, `src/storage/qdrant.ts`, `src/storage/sqlite.ts`, `src/pipeline/index.ts`, `src/resources/index.ts`, and related tests.
- API behavior: `search`, `recall`, and `collection://{name}` become explicit and consistency-preserving when `collection` is omitted or when duplicate content exists across collections.
- Data behavior: prevents silent misses in non-`general` collections and removes ambiguity around cross-collection exact deduplication.
