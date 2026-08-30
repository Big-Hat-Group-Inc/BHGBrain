> **Unblocked (2026-08-29):** `migrate-sqlite-to-native-engine` has landed. The
> `SqliteStore` engine is now `node:sqlite`'s `DatabaseSync`, whose bundled SQLite
> build compiles FTS5 in — `probeFts5Support()` (`src/storage/sqlite.ts`) now returns
> `true` and `SqliteStore.isFts5Available()` reflects it (verified by the flipped
> canary in `src/storage/sqlite.test.ts`). The premise blocking this proposal's tasks
> 1.2 onward ("the pinned sql.js dependency does not compile fts5") no longer holds;
> its remaining 11 tasks can proceed.

## Why

Despite its name, `memories_fts` is a plain table, and `fullTextSearch`
(`src/storage/sqlite.ts:650`) implements "fulltext" as ANDed non-sargable
`LIKE '%term%'` predicates over a capped candidate pool (≤500 rows), ranked by a
hand-rolled term-frequency count. Consequences:

- **No stemming**: "deploy" does not match "deployed"/"deployment"; recall quality on
  natural-language queries is poor, which also degrades the fulltext leg of hybrid RRF.
- **No real relevance model**: the TF count has no document-length normalization or
  term rarity weighting (BM25 has both); common words dominate.
- **Substring false positives**: `LIKE '%cat%'` matches "concatenate".
- **Scaling wall**: every query scans up to the candidate cap with `LOWER()` applied
  per row; past a few thousand memories the fulltext path (and thus every hybrid
  search) slows linearly.

sql.js compiles SQLite with FTS5 available; the engine-level fix has been available
the whole time.

## What Changes

- Replace the plain `memories_fts` table with a real FTS5 virtual table
  (`tokenize = 'porter unicode61'`) over content, summary, and tags, with
  namespace/collection as filterable columns.
- Rank with `bm25(memories_fts, w_content, w_summary, w_tags)` preserving the current
  intent of weighting summary/tags above body (2× today → BM25 column weights).
- Migration on startup: detect the legacy plain table, create the FTS5 table, and
  backfill from `memories` in batches; migration is idempotent and crash-safe
  (rebuildable from `memories` at any time — FTS is derived data).
- Startup capability probe: if the running sql.js build lacks FTS5, fall back to the
  legacy LIKE path and report it via a health `message` + structured log, rather than
  failing closed.
- Keep the `fullTextSearch` signature and `Array<{id, rank}>` contract so hybrid RRF
  (which consumes rank order) is untouched.
- Document the behavior change (stemming, phrase support) in README ×5; bump version.

## Capabilities

### New Capabilities
- `fts5-fulltext`: Fulltext search runs on an FTS5 virtual table with porter stemming
  and BM25 ranking, backfilled from existing data, with a probed fallback to the
  legacy path when the SQLite build lacks FTS5.

### Modified Capabilities

## Impact

- Affected code: `src/storage/sqlite.ts` (table DDL, write-path index maintenance,
  `fullTextSearch`, migration), `src/health/index.ts` (capability surfacing), tests.
- Behavior: fulltext and hybrid results improve (stemming, BM25); exact result sets
  will differ — this is the point, and the eval bar is "strictly better on stemmed
  queries, no regression on exact-term queries".
- Performance: indexed match replaces full-scan LIKE; write path gains a small FTS
  index-maintenance cost per memory write.
- Docs: README ×5, version bump. No config or env changes.
