## Context

- `SqliteStore.searchArchived(namespace, query, limit)` (`src/storage/sqlite.ts:1838-1845`)
  is the only archived-search entry point. Its sole production caller is
  `SearchService.search` (`src/search/index.ts:315-320`), which — when the tool-level
  `include_archived` flag is set — appends `searchArchived(namespace, query, limit)`
  results after the mode-ranked active results, mapped through
  `archiveRecordToSearchResult` (flat placeholder score, `archived: true`, summary
  standing in for content).
- The current implementation lowercases the **whole query** and runs one
  `LIKE '%<query>%'` against `LOWER(summary)` and `LOWER(tags)`, ordered
  `expired_at DESC LIMIT ?`.
- The active-memory fulltext path already defines the project's query-tokenization
  contract: `fullTextSearch` (`src/storage/sqlite.ts:1200-1207`) splits on
  whitespace (`query.toLowerCase().split(/\s+/).filter(Boolean)`), returns `[]` for
  zero terms, and requires all terms to match — explicitly `AND`-joined in both the
  FTS5 branch (`buildFts5MatchExpression`, `:1276-1278`) and the legacy LIKE branch
  (`fullTextSearchLike`, `:1287+`, one `(content LIKE ? OR summary LIKE ? OR tags
  LIKE ?)` conjunct per term).
- Archived rows live in `memory_archive` (summary/tags/tier only — no content, no
  vector) and are **not** in the `memories_fts` FTS5 virtual table; `ensureFtsSchema`
  indexes only `memories`. The archive table is bounded by retention and is
  small relative to active memories.
- Documented contract (`README.md:1779-1784`, `:3135`, `:3139`): archived matches are
  "summary/tag **term**" matches, appended, unranked, never access-recorded.

## Goals / Non-Goals

Goals:
- Make multi-word queries match archived memories the way users — and the README —
  already expect: every whitespace-separated term matches independently against the
  retained summary or tags.
- Keep `searchArchived`'s tokenization byte-for-byte identical to
  `fullTextSearch`'s, via a shared helper, so the two can never drift.
- Close the empty-query edge (`LIKE '%%'` currently matches everything).

Non-Goals:
- No FTS5/BM25 indexing of the archive table. Archived rows are deliberately excluded
  from `memories_fts` (they have no content to index and are appended unranked, not
  scored); adding a second FTS table for a small, unranked, append-only-ish store is
  complexity with no observable ranking benefit. Plain ANDed `LIKE`s keep the same
  full-scan plan the current code already uses.
- No ranking of archived matches. They keep the flat placeholder score and
  `expired_at DESC` ordering — the "appended, not ranked alongside active results"
  contract in `src/search/index.ts:45-51` and `README.md:3139` is unchanged.
- No stemming for archived matches. Active FTS5 search stems ("deploy" matches
  "deployed"); archived LIKE matching is substring-based, so a term matches any
  word containing it, which is close-enough behavior without porting a stemmer.
- No LIKE-wildcard escaping of `%`/`_` inside terms. `fullTextSearchLike` does not
  escape them either (`:1300`, `` `%${term}%` ``); archived search stays consistent
  with the existing legacy-path behavior rather than introducing a third semantics.
  (If escaping is ever wanted, it belongs to both paths in one change.)
- No changes to `SearchService`, tool schemas, or the `include_archived` parameter
  surface. The fix is entirely inside `SqliteStore.searchArchived`.

## Decisions

- **Tokenize with the exact `fullTextSearch` normalization, via a shared helper.**
  Extract `query.toLowerCase().split(/\s+/).filter(Boolean)` into a small private
  static helper (e.g. `SqliteStore.splitQueryTerms(query)`), call it from both
  `fullTextSearch` (replacing its inline expression at `:1201`) and the new
  `searchArchived`. One definition, two callers — the contracts cannot diverge.
- **AND across terms, OR across columns.** Each term contributes one
  `(LOWER(summary) LIKE ? OR LOWER(tags) LIKE ?)` conjunct; conjuncts are joined
  with `AND`. This mirrors `fullTextSearchLike`'s per-term shape exactly (minus the
  `content` column the archive doesn't retain) and implements the same "all terms
  must match" semantics `buildFts5MatchExpression` encodes for the FTS5 branch.
  A term may be satisfied by the summary while another is satisfied by a tag — the
  row matches; that is the point of per-term evaluation.
- **Zero terms → `[]`, before touching SQL.** Matches `fullTextSearch:1202` and
  removes the accidental match-everything behavior. Callers cannot observe a
  distinction between "no terms" and "no matches".
- **One shared core for both archive query paths** (added during implementation):
  `searchArchive` — the namespace-agnostic CLI path (`bhgbrain archive search`, via
  `RetentionService.searchArchive`) — had the byte-identical whole-substring defect.
  Both public methods now delegate to a private
  `searchArchiveByTerms(namespace | null, query, limit)`, so the CLI and MCP archive
  searches share one matching semantics and cannot drift, exactly as `splitQueryTerms`
  guards tokenization drift against `fullTextSearch`.
- **Keep `ORDER BY expired_at DESC LIMIT ?` and the result mapping unchanged.**
  The proposal is only about *which* rows match, not how they are ordered,
  capped, mapped, or presented.
- **Superset guarantee as the compatibility argument.** For any non-empty query,
  the old predicate (whole query as one contiguous substring of summary/tags)
  implies the new one (every individual term is a substring of summary-or-tags) —
  splitting a matched substring on whitespace yields terms that each occur within
  it, and lowercasing is shared. So no existing match is lost; behavior only widens.
  The single intentional narrowing is the empty/whitespace-only query.

## Risks / Trade-offs

- **Broader matching can surface more archived noise.** A query like
  `"the deployment"` now matches any archived row whose summary contains both
  "the" and "deployment" — stop-words are not filtered (they aren't in
  `fullTextSearchLike` either). Bounded by `limit`, by the small size of the
  archive table, and by archived hits being visibly marked `archived: true` and
  appended last. Accepted as strictly better than the current near-total miss rate.
- **Substring (not word-boundary) matching keeps existing quirks.** Term
  `"test"` matches summary word "latest". This is the pre-existing LIKE semantics
  of both the current archived path and the legacy active fallback — unchanged, just
  now applied per-term. FTS5-grade word/stem matching is explicitly out of scope.
- **Perf of N ANDed LIKEs vs one.** The query goes from 2 `LIKE`s to `2×N` for an
  N-term query, still one full scan of a small table with an early `LIMIT`. No
  index could serve leading-wildcard `LIKE`s before or after; no measurable
  regression expected at archive-table scale (`memory_archive` holds only expired
  T-tier rows).
