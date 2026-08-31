## Why

The `optimize-read-path-memory-efficiency` change shipped the read-path performance work
(bulk hydration, batched access recording, budgeted inject assembly), but follow-up audits
surfaced correctness gaps that the original change did not close:

- The spec's load-bearing "preserves ranking order" guarantee is implemented via a
  service-layer `memoryMap`, but it is **untested** — the existing test only asserts that
  `getMemoriesByIds` was *called*, not that the response order matches the ranking. An
  `IN (...)` query does not guarantee input order, so a regression that trusted SQL row
  order would pass CI silently.
- The auto-inject truncation check (`fullyIncluded`) compares a JS UTF-16 `.length` against
  SQLite's character-based `LENGTH()`, so multibyte/astral content can mis-truncate near the
  budget boundary — marking a payload complete when content was cut, or the reverse.
- `recordAccessBatch` runs a per-row UPDATE loop that re-builds and re-parses the SQL string
  on every iteration, defeating part of the per-hit-overhead reduction the original change
  set out to achieve.
- The cross-device Qdrant fallback reconstructs a `SearchResult` from an untrusted Qdrant
  payload using unchecked `as string` / `as SearchResult[...]` casts (one `content` typeof
  guard aside). A malformed or cross-version payload propagates invalid values into results
  without error.

These are correctness and trust-boundary defects on the hottest read paths. Left as-is, a
reordering regression is invisible, truncation can be wrong on non-ASCII content, and
malformed external data can flow into results unchecked.

## What Changes

- Add a test that asserts bulk-hydrated search results preserve ranking order even when
  `getMemoriesByIds` returns rows in a different order than the ranked input.
- Make the inject budget/truncation accounting use consistent character-counting semantics
  on both sides of the `fullyIncluded` comparison so the budget is honored exactly,
  including for multibyte content; add multibyte coverage.
- Rework `recordAccessBatch` to reuse a single prepared statement across rows (no per-row
  SQL re-parse), preserving current behavior.
- Validate/parse the Qdrant payload shape before constructing a `SearchResult` in the
  cross-device fallback, replacing unchecked casts with guarded narrowing and defaults.

## Capabilities

### New Capabilities
- `read-path-correctness`: Read-path results are order-preserving, truncation is budget-exact
  across character encodings, access persistence reuses prepared statements, and
  externally-sourced (Qdrant) payloads are validated before use.

### Modified Capabilities

## Impact

- Affected code: `src/search/index.ts`, `src/resources/index.ts`, `src/storage/sqlite.ts`,
  and their co-located `.test.ts` files.
- Correctness: ranking order, truncation accuracy on non-ASCII content, and trust-boundary
  validation are guaranteed and regression-guarded.
- Performance: `recordAccessBatch` reduces SQL parsing churn on the hot read path.
- No user-visible API or schema changes; behavior is hardened, not altered.
