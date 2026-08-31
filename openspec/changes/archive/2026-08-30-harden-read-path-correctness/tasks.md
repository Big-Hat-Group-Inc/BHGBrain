## 1. Guard ranking-order preservation with a test

- [x] 1.1 Add a test in `src/search/index.test.ts` where the ranked input is e.g.
  `['mem-3', 'mem-1', 'mem-2']` and the mocked `getMemoriesByIds` returns the rows in a
  *different* order (e.g. ascending id), then assert the resulting `SearchResult[]` order
  matches the ranked input order, not the SQL return order.
- [x] 1.2 Add a test covering the cross-device Qdrant-fallback branch (`src/search/index.ts`
  ~189-209): a ranked id absent from `getMemoriesByIds` but present in `qdrantPayload`,
  asserting reconstructed fields and defaults.

## 2. Make inject truncation budget-exact across encodings

- [x] 2.1 Make the `fullyIncluded` comparison in `src/resources/index.ts` use consistent
  character-counting semantics on both sides (compare against the same unit the slice was
  requested with, or have `getCategoryContentSlice` return the underlying character length),
  so JS UTF-16 `.length` is not compared against SQLite `LENGTH()`.
- [x] 2.2 Ensure the budget guard and truncation flag are computed consistently so the
  character budget is honored exactly near the boundary for multibyte/astral content.
- [x] 2.3 Add a test in `src/resources/index.test.ts` with multibyte/astral category content
  that exercises truncation at the budget boundary and asserts the `truncated` flag and
  payload size are correct.

## 3. Reuse a prepared statement in recordAccessBatch

- [x] 3.1 Rework `recordAccessBatch` in `src/storage/sqlite.ts` to reuse a single prepared
  statement across rows (e.g. always bind the full column set, or group rows by SET-shape),
  eliminating the per-row SQL string rebuild and re-parse.
- [x] 3.2 Confirm existing access-recording behavior is unchanged (access_count,
  last_accessed, and optional expires_at/retention_tier/review_due updates) and covered by
  tests.

## 4. Validate the Qdrant fallback payload before use

- [x] 4.1 In `src/search/index.ts` (~194-205), validate/parse the Qdrant payload shape
  before constructing the `SearchResult` — narrow each field (typeof / `Array.isArray(...)`
  with element-type checks / enum membership) or route through a small Zod parse — replacing
  the unchecked `as string` / `as SearchResult[...]` casts.
- [x] 4.2 Fall back to the existing defaults when a field is missing or malformed, so a
  partial/cross-version payload never propagates an invalid value into a `SearchResult`.

## 5. Validation

- [x] 5.1 Run `npm run lint`, `npm test`, and `npm run build`.
