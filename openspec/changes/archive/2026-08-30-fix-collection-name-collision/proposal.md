## Why

**Live, exploitable correctness bug on `main` today**, introduced by `fix-namespace-slash-collection-naming` (merged 2026-08-29): two logically distinct `collection` values can silently resolve to the *same physical Qdrant collection*, causing cross-collection data leaks on read and cross-collection data destruction on delete — via nothing more than a `remember` call any caller can already make.

Root cause: `QdrantStore.collectionName()` (`src/storage/qdrant.ts`) builds the physical Qdrant name via `encodeCollectionNameSegment()`, which replaces `/` with `.` and is applied to both the `namespace` and `collection` arguments. Its correctness comment asserts this is injective because "raw namespace/collection inputs never contain `.`" — true for `namespace` (`NamespaceSchema` is `^[a-zA-Z0-9/-]{1,200}$`, excluding `.`), but **false for `collection`**: `collection`'s real validation schema, `NameSchema` (`src/domain/schemas.ts:18`), is `z.string().min(1).max(100)` — no charset restriction at all. Every one of `NameSchema`'s six usages (`src/domain/schemas.ts`) is `collection` or `category.name`, always an identifier-like field, never free text.

Consequence: `collection: "a.b"` (literal dot, unchanged by encoding — no `/` to replace) and `collection: "a/b"` (slash, encoded to `.`) both resolve to the identical Qdrant collection name `bhgbrain_<ns>_a.b`. SQLite's `collections` table and `memories.collection` column correctly keep them as distinct rows/values, but Qdrant — the store `search()`/`recall()` actually queries — sees one collection.

Confirmed impact:
- `QdrantStore.search()` filters candidates by `namespace`/`type`/`tags`/date range in its Qdrant payload `must` clause — there is **no `collection` payload filter at all**. Isolation between two `collection` values depends entirely on them living in separate physical Qdrant collections. When they collide, `recall`/`search` scoped to one `collection` silently returns vectors written under the other.
- `collections delete` with `force: true` → `QdrantStore.deleteCollection` drops the entire physical Qdrant collection by name. Deleting `collection: "a.b"` silently destroys all of `collection: "a/b"`'s vectors too, while the other collection's SQLite metadata/row survives untouched — a silent, undetected data-loss path with no error surfaced.
- `category.name` (`CategoryInputSchema.name`, also `NameSchema`) has the identical charset gap. Categories aren't embedded in a Qdrant collection name today, so this is lower severity, but shares the same root cause and should close at the same time.

No existing test catches this: `src/storage/qdrant.test.ts` has zero references to `collectionName`/`encodeCollectionNameSegment` beyond the 3 tests `fix-namespace-slash-collection-naming` added for the *namespace*-side collision — the *collection*-side case was never exercised.

## What Changes

- Tighten `collection`'s (and `category.name`'s) input validation to a slug-like charset that excludes both `.` and `/` — closing the collision at its source and finally enforcing what `src/storage/qdrant.ts`'s own comment already assumed was true ("alphanumeric/hyphen by convention").
- Make `encodeCollectionNameSegment()` provably injective regardless of what the schema allows (defense in depth, matching this codebase's layered-validation pattern): escape any literal occurrence of the substitution marker character before encoding `/`, rather than assuming raw input can never contain it.
- Add regression coverage proving `collection: "a.b"` and `collection: "a/b"` no longer collide, that a literal `.`/`/` in `collection` is now rejected at the schema boundary with `INVALID_INPUT`, and that the existing namespace-slash-safety tests still pass unchanged.

## Capabilities

### New Capabilities
- `collection-name-encoding`: defines the charset `collection`/`category.name` values must satisfy, and the injectivity guarantee the Qdrant collection-name encoder must uphold regardless of that charset.

### Modified Capabilities

## Impact

- Affected code: `src/domain/schemas.ts` (`NameSchema` / new collection-specific pattern), `src/storage/qdrant.ts` (`encodeCollectionNameSegment`, `collectionName`), and related tests (`src/storage/qdrant.test.ts`, `src/domain/schemas.test.ts` or wherever schema validation is tested).
- API behavior: `remember`, `recall`, `search`, `collections`, `consolidate`, `category` reject `collection`/`category.name` values containing `.` or `/` with a clear `INVALID_INPUT` instead of silently colliding two collections together.
- Data behavior: any collection created *before* this fix with a literal `.` in its name (unlikely in practice, but not provably impossible) keeps working for existing reads/writes against its already-created Qdrant collection; only *new* collection names are subject to the tightened validation. No migration of existing Qdrant collections is required.
