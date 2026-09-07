## Why

Search, recall, linked expansion, resource injection, archived lookup, and reranking apply inconsistent eligibility and scoring rules. The result is expired content resurfacing, requested archived matches disappearing, valid full-text results under-returning, and unstable or incomparable rankings.

## What Changes

- Apply the same archived and expiry eligibility rules to direct results, linked memories, injected resources, collection resources, and result backfill.
- Give archived results an explicit result budget/merge contract when `include_archived` is requested.
- Ignore untokenizable full-text terms, escape LIKE wildcards, and use a scale-aware BM25 normalization.
- Add deterministic ranking tie-breakers and keep reranked candidates ahead of candidates the reranker did not evaluate.
- Preserve requested result limits after filtering expired rows.
- Make consolidation partial failures accurately update lineage and retain structured diagnostics.

## Capabilities

### New Capabilities
- `retrieval-result-consistency`: Defines common eligibility, result budgeting, query sanitization, deterministic ranking, rerank ordering, and consolidation-result semantics.

### Modified Capabilities

## Impact

- Affected code: `src/search/index.ts`, `src/storage/sqlite.ts`, `src/tools/index.ts`, `src/resources/index.ts`, retrieval schemas, and search/recall/resource tests.
- Audit coverage: F39-F43, F73-F75, F78, and F79.
- User-visible behavior: expired memories stay hidden consistently and result limits/rankings become predictable.
