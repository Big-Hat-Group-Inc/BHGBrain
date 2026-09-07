## Context

Eligibility filtering currently lives in several layers, archive matches are appended after active truncation, and full-text/rerank scores are merged despite incompatible scales. See `proposal.md` and `specs/retrieval-result-consistency/spec.md`.

## Goals / Non-Goals

**Goals:**
- Apply one active-memory eligibility rule to every read surface.
- Make result budgets, parsing, and ordering deterministic and testable.
- Keep consolidation lineage accurate under partial cleanup.

**Non-Goals:**
- Replacing BM25, semantic search, RRF, MMR, or the optional reranker.
- Changing archived memory contents or retention policy.

## Decisions

1. Centralize active eligibility as a clock-aware predicate used before limit consumption.
- Store queries will apply it where possible; payload/link/resource fallbacks will use the same domain helper.
- Filtering only after truncation was rejected because it under-returns and diverges across surfaces.

2. Give archive search a separate additive budget.
- `limit` continues to govern active results; a bounded archive limit governs appended marked archive matches and is reflected in schemas/docs.
- Mixing archive and active scores was rejected because archive summaries and active hybrid scores are not comparable.

3. Normalize query terms once.
- The tokenizer removes zero-token terms, quotes FTS expressions, and escapes LIKE `%`, `_`, and the escape character. No remaining term returns no matches.
- Passing raw punctuation or wildcard patterns to backend-specific syntax was rejected.

4. Replace the fixed full-text divisor with rank-relative normalization.
- Full-text scores are normalized monotonically within the candidate set before fusion; score sorts use ID tie-breakers.
- Fixed `/10` saturation was rejected because common multi-term ranks collapse to the same value.

5. Preserve a two-tier rerank ordering.
- Reranked pool members sort by rerank score; untouched candidates sort by composite score and follow the pool.
- Sorting both together numerically was rejected because the score scales have different meanings.

6. Finalize merge lineage after per-source outcomes are known.
- The merge records succeeded, pending, and failed sources explicitly and logs each failure cause.
- Optimistically stamping every source before deletion was rejected because it asserts completion that may not occur.

## Risks / Trade-offs

- [Archive results increase response size] -> Use a separate small configurable cap and the global character budget.
- [Central eligibility changes edge-case ordering] -> Add cross-surface fixtures with a fixed clock before migration.
- [Rank-relative normalization changes hybrid relevance] -> Run the golden-set eval and record recall/MRR before accepting thresholds.

## Migration Plan

1. Add shared eligibility and query-normalization helpers with regression fixtures.
2. Update storage, search, tool, link, and resource paths.
3. Add archive budgeting and full-text backfill.
4. Add deterministic normalization/rerank ordering and run retrieval evals.
5. Update consolidation result and lineage handling.
