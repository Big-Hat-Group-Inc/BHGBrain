## Why

`SqliteStore.searchArchived` (`src/storage/sqlite.ts:1838-1845`) matches the **entire
query string** as a single `LIKE '%<query>%'` substring against an archived row's
retained `summary` and `tags`:

```ts
const like = `%${query.toLowerCase()}%`;
// ... WHERE namespace = ? AND (LOWER(summary) LIKE ? OR LOWER(tags) LIKE ?)
```

Any multi-word query therefore only matches when the words appear **contiguously, in
order** in the summary or serialized tags. In practice they almost never do: a live
functionality test against the deployed server (2026-08-30) archived a memory whose
summary begins "Deployment note for the functional test: the WSL sandbox runs Qdrant
in Docker…", then searched with `include_archived: true`:

- query `"deployment note functional test"` → **no archived hit** (the literal
  substring `"deployment note functional test"` never occurs — "for the" breaks it)
- query `"sandbox deployment Docker Qdrant"` → **no archived hit** (words present but
  not contiguous)
- query `"deployment"` → hit

This directly contradicts how every *active*-memory fulltext path already works:
`fullTextSearch` (`src/storage/sqlite.ts:1200-1207`) splits the query on whitespace
and requires **each term** to match independently (FTS5 `AND`-joined phrases via
`buildFts5MatchExpression`, or per-term ANDed `LIKE`s in the legacy fallback). The
`search` tool's one documented archived contract — "finds archived memories by
summary/tag **term**" (`README.md:1779-1784`, `:3135`) — describes term matching, but
the implementation does whole-string matching. Since natural search queries are
almost always multi-word, `include_archived: true` is effectively broken for its
primary use case.

A second latent defect falls out of the same shape: an empty or whitespace-only query
produces `LIKE '%%'`, which matches **every** archived row in the namespace up to
`limit`, where `fullTextSearch` returns `[]` for the same input.

## What Changes

- Tokenize the query in `searchArchived` using the same normalization
  `fullTextSearch` uses (`query.toLowerCase().split(/\s+/).filter(Boolean)`), and
  require **every** term to match the row — each term independently against
  `LOWER(summary) LIKE '%term%' OR LOWER(tags) LIKE '%term%'`, terms joined with
  `AND` — mirroring the per-term/per-column shape of `fullTextSearchLike`
  (`src/storage/sqlite.ts:1287-1302`).
- Apply the identical fix to the namespace-agnostic sibling `searchArchive`
  (`src/storage/sqlite.ts:1831-1838`, the CLI's `bhgbrain archive search` path via
  `RetentionService.searchArchive`) — it has the same whole-substring defect over the
  same table; both methods now delegate to one shared private core so the two archive
  query paths cannot diverge. (Scope extension discovered during implementation.)
- Hoist the query normalization into one shared private helper used by both
  `fullTextSearch` and `searchArchived`, so the two tokenization contracts cannot
  drift apart again.
- Return `[]` when tokenization yields no terms (empty/whitespace-only query),
  closing the `LIKE '%%'` match-everything edge and matching `fullTextSearch`'s
  existing contract.
- Everything else about archived matching stays fixed: results still ordered
  `expired_at DESC`, still capped by `limit`, still appended after active results by
  `SearchService` (`src/search/index.ts:315-320`) with the flat placeholder score and
  `archived: true` marker.
- Update the `search` tool's `include_archived` documentation in `README.md`
  (`:1779-1784` archive-section paragraph, `:3135` parameter table, `:3139` output
  note) to state per-term matching explicitly; mirror into the four translated
  READMEs; bump `package.json` via `npm version patch`.

The change strictly **widens** recall for every non-empty query: any summary/tags
that matched the old contiguous substring necessarily also matches every individual
term of that substring, so no currently-working query loses its results. The only
narrowing is the empty-query edge, which today returns arbitrary rows and afterward
returns none.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `memory-review-and-archive-recall`: the "Search SHALL optionally include archived
  memories" requirement (from `add-review-and-archive-recall`) is tightened — a
  multi-word query SHALL match an archived memory when **each** whitespace-separated
  term independently matches its retained summary or tags, rather than only when the
  whole query occurs as one contiguous substring; a query with no terms SHALL match
  nothing.

## Impact

- Affected code: `src/storage/sqlite.ts` (`searchArchived`, plus the small shared
  term-split helper touching `fullTextSearch`'s first line), `src/storage/sqlite.test.ts`.
  `src/search/index.ts` is unchanged — `searchArchived`'s signature and result shape
  are identical.
- Affected behavior: `search` calls with `include_archived: true` and multi-word
  queries start returning the archived matches users would expect; single-term
  queries behave exactly as today; empty queries stop matching every archived row.
- No schema, config, index, or transport changes; no new dependencies. The archive
  table is deliberately small (summary/tags only, bounded by retention), so ANDed
  per-term `LIKE`s over it are not a performance concern — this stays on the same
  full-scan LIKE plan the current single-substring version uses.
- Docs: `README.md` + `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md` (all five or none, per CLAUDE.md), `package.json` version bump
  (currently `1.34.3`).
