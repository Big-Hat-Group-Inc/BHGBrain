## Context

`optimize-read-path-memory-efficiency` is complete and spec-compliant: search hydration uses
a single `getMemoriesByIds()` bulk lookup with a service-layer `memoryMap` to restore ranking
order, read-path access recording is batched and deferred, and auto-inject assembles content
incrementally against a character budget using DB-side `substr` slicing.

Two audits of that change (plus the `eliminate-any-type-casting` audit) flagged net-new
correctness issues that the original change's scope did not cover. They cluster around four
sites:

1. `src/search/index.ts:180-185` — bulk fetch + `memoryMap` re-ordering. Correct, but the
   ordering guarantee is the design's explicitly-noted risk and is **unasserted** by tests.
2. `src/resources/index.ts:161` — `fullyIncluded = content.length >= cat.content_length`
   compares JS UTF-16 code units against SQLite character count.
3. `src/storage/sqlite.ts:672-689` — `recordAccessBatch` calls `db.run(...)` per row, which
   re-prepares and frees a statement and rebuilds the SQL string each iteration.
4. `src/search/index.ts:194-205` — cross-device fallback reconstructs `SearchResult` from an
   untrusted Qdrant payload (`Record<string, unknown>`) with unchecked casts; only `content`
   is type-guarded.

This change hardens those four sites without altering user-visible behavior.

## Goals / Non-Goals

Goals:
- Regression-guard the "preserves ranking order" guarantee with a direct test.
- Make inject truncation/budget accounting exact across character encodings.
- Reuse a prepared statement in `recordAccessBatch` to cut per-hit SQL parsing.
- Validate the Qdrant fallback payload at the trust boundary before use.

Non-Goals:
- No changes to the read-path public API, MCP tool schemas, or memory model.
- Not reconciling the cross-device access-recording asymmetry (fallback rows have no local
  SQLite row to update); that is an informational audit note, not a defect.
- Not addressing the lower-priority audit notes (RRF object-spread micro-allocation, silent
  embedding-fallback log, named magic offsets) — out of scope here.

## Decisions

1. **Ranking order is verified by adversarial test data, not implementation inspection.** The
   new test feeds a ranked input whose order differs from the mocked `getMemoriesByIds`
   return order, so a buggy implementation that trusted SQL row order would fail. This pins
   the `memoryMap` mitigation against the design's stated risk.

2. **Character-counting is unified on the inject path.** Rather than comparing JS `.length`
   to SQLite `LENGTH()`, both sides use the same unit. Preferred approach: have
   `getCategoryContentSlice` return (or the caller compute) the underlying character length so
   `fullyIncluded` and the budget guard agree. This keeps the budget honored exactly at the
   boundary regardless of multibyte/astral content. ASCII behavior is unchanged.

3. **`recordAccessBatch` reuses one prepared statement.** The SET-shape varies per row
   (optional `expires_at`/`retention_tier`/`review_due`), so a single static statement is not
   a drop-in. Approach: always bind the full column set (binding unchanged values) so one
   prepared statement is reused across all rows, or group rows by SET-shape and reuse a
   statement per group. Behavior (which columns change) is preserved.

4. **Qdrant payload is narrowed before use, not asserted.** Each field is guarded with a
   typeof / `Array.isArray(...).every(...)` / enum-membership check (mirroring the existing
   `content` guard), or parsed via a small Zod schema, falling back to the current defaults
   (`summary ''`, `type 'semantic'`, `tags []`, `retention_tier 'T2'`, etc.) on mismatch. No
   invalid value reaches a `SearchResult`.

## Risks / Trade-offs

- **Prepared-statement reuse with full-column binding** writes columns that previously stayed
  untouched when their update field was `undefined`. Mitigation: bind the row's current value
  for those columns so the UPDATE is a no-op write, preserving observable state; covered by
  existing/extended tests.
- **Unified character counting** could shift a boundary truncation by a character vs. today
  for ASCII content. Mitigation: ASCII `.length` already equals SQLite `LENGTH()`, so ASCII
  results are unchanged; tests cover both ASCII and multibyte.
- **Payload validation defaults** could mask genuinely malformed cross-device data by
  silently substituting defaults. Mitigation: this matches existing fallback behavior for
  `content`; defaults are the intended degraded-mode contract, and a future log/metric can be
  added separately.

## Migration Plan

No data migration. All changes are in-process logic plus tests:
1. Add the ranking-order and fallback-branch tests (red against any future regression).
2. Unify inject character counting and add multibyte test.
3. Refactor `recordAccessBatch` to reuse a prepared statement.
4. Add Qdrant payload validation/narrowing.
5. Run `npm run lint`, `npm test`, `npm run build`.

No config, schema, or env changes; nothing to roll back beyond reverting the commit.

## Open Questions

- Should a malformed-payload mismatch in the Qdrant fallback emit a `logger.debug`/metric for
  observability, or silently default (current behavior)? Defaulting silently is assumed for
  this change; observability can follow separately.
- For `recordAccessBatch`, is full-column binding (one statement) preferred over SET-shape
  grouping? Both satisfy "no per-row re-parse"; full-column binding is simpler and assumed
  unless a benchmark shows the extra binds matter.
