## Context

`fullTextSearch` tokenizes the query on whitespace, ANDs `LIKE '%term%'` predicates
over content/summary/tags, pulls up to 500 candidates, and ranks them in JS by
occurrence counting with 2× weight on summary/tags. It replaced an earlier constant
rank precisely because ordering feeds hybrid RRF — so the ordering contract
(`Array<{id, rank}>`, descending relevance, deterministic tie-break) is load-bearing
and must survive this change untouched.

sql.js is compiled from full SQLite amalgamation with FTS5 enabled in the standard
distribution; still, the build is a project dependency that can change, so FTS5
availability is probed rather than assumed.

## Goals / Non-Goals

Goals:
- Engine-level matching (stemmed, indexed) and ranking (BM25) for fulltext.
- Zero-risk migration: FTS index is derived data, rebuildable from `memories`.
- Graceful degradation to today's behavior when FTS5 is absent.

Non-Goals:
- No query-syntax surface for users (phrase/NEAR operators are neutralized, not
  exposed) — exposing MATCH syntax is a follow-up with its own validation story.
- No change to hybrid fusion or semantic search.
- No CJK-specific tokenization (unicode61 only; noted as a follow-up for the zh-CN
  audience — trigram tokenizer evaluation).

## Decisions

- **Porter + unicode61 tokenizer**: stems English, handles diacritics; the dominant
  content language in practice. CJK behavior is no worse than today's LIKE (which
  substring-matched CJK; FTS5 unicode61 token-splits it) — the trigram follow-up is
  called out in the proposal rather than silently regressing: task 4.x includes a CJK
  smoke test to characterize behavior.
- **Query sanitization**: user queries are split into bareword tokens and joined with
  implicit AND; every token is double-quoted in the MATCH expression so FTS5
  operators in user input are inert. Empty token list returns `[]` (current
  behavior).
- **BM25 weights**: `bm25(t, 1.0, 2.0, 2.0)` (content, summary, tags) mirroring the
  current 1×/2×/2× intent. Note bm25() returns *lower is better*; negate before
  filling `rank` so the existing "higher rank first" sort keeps working.
- **Migration strategy**: `CREATE VIRTUAL TABLE memories_fts5 ...`, batch INSERT from
  `memories` (500/batch inside a transaction), then `DROP TABLE memories_fts` and
  rename. Presence of the FTS5 table is the migration marker; on any doubt, drop and
  rebuild — source of truth is `memories`.
- **Write-path hooks**: FTS maintenance lives beside the existing `memories_fts`
  write-through code paths (insert/update/delete/archive/restore/repair), replacing
  them 1:1, so no new write orchestration is introduced.

## Risks / Trade-offs

- Result-set drift: stemmed matching returns more results; any test pinning exact
  LIKE-era result sets must be updated deliberately, not loosened blindly.
- sql.js persistence: the FTS5 index lives in the same serialized DB image, growing
  file size (~30-60% of text size). Accepted; the alternative (external index) is a
  much bigger change.
- Double maintenance during rollout is avoided by hard-swapping tables in one
  migration rather than dual-writing.
