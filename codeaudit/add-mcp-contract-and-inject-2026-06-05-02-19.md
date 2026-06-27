# Code Audit — OpenSpec proposal `add-mcp-contract-and-inject`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `add-mcp-contract-and-inject`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 13 (`src/tools/schemas.ts`, `src/tools/index.ts`, `src/tools/index.test.ts`, `src/resources/index.ts`, `src/resources/index.test.ts`, `src/search/index.ts`, `src/search/index.test.ts`, `src/errors/index.ts`, `src/domain/schemas.ts`, `src/domain/schemas.test.ts`, `src/domain/types.ts`, `src/storage/sqlite.ts`, `src/index.ts`)

## Executive summary

The proposal is largely implemented and well-structured: tool contracts use a strict Zod registry (`additionalProperties: false` mirrored by `.strict()`), a shared error factory produces the standard `{ error: { code, message, retryable } }` envelope, resource handlers and the budgeted `memory://inject` pipeline exist, and hybrid search uses Reciprocal Rank Fusion with configurable weights. Overall health is good with no Critical/High security or stability defects found. The two material gaps are spec drifts, both Medium severity: (1) fulltext search returns a **constant relevance score** (`rank = -terms.length`) so "lexical-ranked" results do not actually rank and RRF receives degenerate fulltext ranks; and (2) the `category://` and `collection://` resources **ignore namespace scoping**, contradicting the namespace-visibility requirement. Headline counts: 0 Critical, 0 High, 4 Medium, 4 Low.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Tools SHALL enforce strict input schemas (`additionalProperties: false`, bounds, enums) | Done | `src/tools/schemas.ts:19,37,...`; Zod `.strict()` in `src/domain/schemas.ts:36,46,...` |
| Scenario: Unknown input field rejected → `INVALID_INPUT` | Done | `.strict()` + `parseInput` maps `ZodError`→`invalidInput` (`src/tools/index.ts:34-44`); test `src/domain/schemas.test.ts:32` |
| Scenario: Out-of-bounds input rejected → `INVALID_INPUT` | Done | bounds in `src/domain/schemas.ts:16-17,44,57`; mapped via `parseInput` |
| Tool responses SHALL match declared output contracts | Partial | `remember` returns full `WriteResult` (`id,summary,type,operation,created_at`) `src/domain/types.ts:84-91`; but no JSON-schema/test pins output shape per tool |
| Scenario: `remember` returns id/summary/type/operation/created_at | Done | `src/tools/index.ts:95-113` returns pipeline `WriteResult` |
| Scenario: `collections list` returns name+count | Done | `src/tools/index.ts:184`; `listCollections` returns `{name,count}` `src/storage/sqlite.ts:960` |
| Tool errors SHALL use standard envelope | Done | `src/errors/index.ts:13-22`; `handleTool` catch `src/tools/index.ts:63-69` |
| Scenario: Validation failure → INVALID_INPUT envelope | Done | `src/tools/index.ts:39-41`, `src/errors/index.ts:24-26` |
| Scenario: Embedding outage → `EMBEDDING_UNAVAILABLE`, no silent success | Partial/Drifted | `src/search/index.ts:65-66` (semantic) and `embeddingUnavailable` exist, but **hybrid mode silently swallows** embedding failure and degrades to fulltext-only `src/search/index.ts:125-127` |
| Resource URIs expose memory/category/collection/health views | Done | `src/resources/index.ts:24-37,242-255` |
| Scenario: `memory://list` cursor-paginated, newest first | Done | `src/resources/index.ts:73-92`; `ORDER BY created_at DESC, id DESC` `src/storage/sqlite.ts:523` |
| Scenario: `memory://{id}` full details | Done | `src/resources/index.ts:59-68` |
| Resource reads SHALL enforce namespace visibility | Drifted | `memory://` honors `?namespace`; **`category://` has no namespace dimension**, **`collection://` ignores it and hardcodes `'global'`** `src/resources/index.ts:230,234` |
| Scenario: Default read namespace-scoped | Partial | memory yes; collection/category no |
| Scenario: Explicit `?namespace` selects target namespace | Drifted | `collection://list` calls `listCollections()` with no namespace; `collection://{name}` hardcodes `'global'` `src/resources/index.ts:230,234` |
| `memory://inject` fixed order: categories → top memories → truncation | Done | `src/resources/index.ts:142-190` |
| Scenario: category content before recalled memories | Done | `src/resources/index.ts:142-187` |
| Scenario: include up to top-k recalled memories | Done | `src/resources/index.ts:171-172` (`auto_inject_limit`) |
| Inject SHALL enforce budget + truncation metadata | Done | budget loop `src/resources/index.ts:121-198`; `truncated`/`total_results` returned |
| Scenario: over-budget → summary fallback + `truncated:true` | Done | `src/resources/index.ts:178-190` (content→summary fallback, `truncated`) |
| Scenario: under-budget → complete payload, `truncated:false` | Done | `truncated` stays false when nothing trimmed `src/resources/index.ts:189-190` |
| Search SHALL support semantic/fulltext/hybrid, default hybrid | Done | `src/search/index.ts:41-48`; default in `src/domain/schemas.ts:56` |
| Scenario: semantic → vector-ranked | Done | `src/search/index.ts:56-86` |
| Scenario: fulltext → lexical-ranked | Drifted | rank is constant `-terms.length` for all rows `src/storage/sqlite.ts:571,577` — not relevance-ranked |
| Hybrid SHALL use RRF with configurable weights | Done | `src/search/index.ts:146-160`; `RRF_K=60`, `config.search.hybrid_weights` |
| Scenario: hybrid result includes overall + semantic + fulltext scores | Done | `src/search/index.ts:162-170`, `src/domain/types.ts:74-75` |
| Scenario: configured weights influence ordering | Done | `src/search/index.ts:148-156` uses `weights.semantic`/`weights.fulltext` |
| Task 1.1 strict JSON schema for all tools | Done | `src/tools/schemas.ts` |
| Task 1.2 shared validation → `INVALID_INPUT` envelope | Done | `parseInput` `src/tools/index.ts:34-44` |
| Task 1.3 success payload serializers per tool | Partial | handlers shape responses inline; no dedicated serializer layer (acceptable) |
| Task 2.1 resource handlers (memory/category/collection/health) | Done | `src/resources/index.ts` |
| Task 2.2 inject composition (category-first + top-k) | Done | `src/resources/index.ts:142-187` |
| Task 2.3 inject + response budget truncation metadata | Done | `src/resources/index.ts:121-198` |
| Task 3.1 semantic/fulltext/hybrid routing | Done | `src/search/index.ts:41-48` |
| Task 3.2 RRF hybrid with configurable weights | Done | `src/search/index.ts:107-170` |
| Task 3.3 contract tests for all tool schemas + error envelopes | Partial | only `collections` delete + one schema strictness test; no per-tool out-of-bounds/unknown-field coverage for recall/search/tag/category/backup |
| Task 3.4 integration tests for resource + inject budget | Done | `src/resources/index.test.ts:61-109` |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | Medium | High | M | Maintainability / Spec | `src/storage/sqlite.ts:571,577` | Fulltext "relevance" rank is a constant per query; no lexical ranking |
| 2 | Medium | High | M | Security / Spec | `src/resources/index.ts:230,234` | `collection://` ignores namespace, hardcodes `global`; cross-namespace exposure risk |
| 3 | Medium | High | S | Stability / Spec | `src/search/index.ts:125-127` | Hybrid silently swallows embedding outage; no log, no `EMBEDDING_UNAVAILABLE` signal |
| 4 | Medium | Medium | M | Testing | `src/tools/index.test.ts` | No contract tests asserting INVALID_INPUT for recall/search/tag/category/backup bounds |
| 5 | Low | High | M | Performance | `src/resources/index.ts:234-237` | `collection://{name}` loads 50 rows then filters in JS instead of querying by collection |
| 6 | Low | Medium | S | Performance | `src/storage/sqlite.ts:556,566` | Fulltext uses `LOWER(...) LIKE %term%` (non-sargable full scan) despite FTS table present |
| 7 | Low | High | S | Maintainability | `src/tools/schemas.ts:33-34` | JSON-schema `recall.min_score` lacks bounds/default present in Zod (doc drift) |
| 8 | Low | Medium | S | Maintainability | `src/resources/index.ts:21-22,41` | Brittle URI parsing (`hostname || pathname.replace('//','')`) duplicated across handlers |

## Quick wins

- **#3** Log a warning and/or surface `EMBEDDING_UNAVAILABLE` partiality when hybrid drops to fulltext-only (`src/search/index.ts:125-127`). Currently a hard dependency outage is invisible.
- **#7** Add `minimum/maximum/default` to `recall.min_score` in `src/tools/schemas.ts` to match the authoritative Zod schema and keep client-facing JSON schema honest.

## Performance

### [Low · High · M] `collection://{name}` over-fetches then filters in memory — `src/resources/index.ts:234-237`
**Issue:** The handler fetches a fixed 50 newest memories in the (hardcoded `global`) namespace and filters by collection in JavaScript. Memories in the target collection beyond the 50 newest namespace rows are silently invisible, and the fetch is unbounded by collection.
**Why it matters:** Correctness (missing results) plus wasted I/O; behavior is not paginated and not collection-scoped at the query level.
**Recommendation:** Add a `listMemoriesByCollection(namespace, collection, limit, cursor)` query and paginate like `memory://list`.

### [Low · Medium · S] Fulltext search is a non-sargable LIKE scan — `src/storage/sqlite.ts:556,566`
**Issue:** Despite a `memories_fts` table, matching uses `LOWER(f.content) LIKE '%term%'` (leading wildcard + function on column), which cannot use an index and scans the FTS table linearly per term.
**Why it matters:** O(rows × terms) per query on the read hot path; scales poorly as memory count grows.
**Recommendation:** Use the FTS5 `MATCH` operator (with `bm25()` for ranking, which also fixes finding #1) rather than `LIKE`.

## Logging & observability

### [Medium · High · S] Hybrid search swallows embedding failure without logging — `src/search/index.ts:125-127`
**Issue:** `catch { /* fall back to fulltext only */ }` discards the error with no Pino log, no metric, and no indication to the caller that semantic ranking was skipped. Semantic mode correctly raises `EMBEDDING_UNAVAILABLE` (`:65-66`); hybrid does not.
**Why it matters:** The spec scenario "embedding unavailable during a write path … does not silently succeed" reflects an intent that dependency outages be observable. A degraded hybrid result is indistinguishable from a healthy one, hampering troubleshooting and silently changing ranking quality.
**Recommendation:** Log at `warn` with the error and a `degraded: 'fulltext_only'` field; optionally add a `degraded` flag to the response or increment a metric counter.

## Stability & reliability

### [Medium · High · S] Embedding-outage contract drift in hybrid path — `src/search/index.ts:119-127`
**Issue:** Same code as #3 from the reliability angle: hybrid silently degrades. While graceful degradation is defensible, it is undocumented in the spec and untestable by clients.
**Why it matters:** Cross-client consistency: a client cannot tell whether it received a hybrid or fulltext-only ranking. Idempotency/repeatability of results (a stated design goal) is undermined.
**Recommendation:** Make degradation explicit (response field or metric) and assert it in a test.

## Security

### [Medium · High · M] Resource namespace scoping not enforced for collection/category — `src/resources/index.ts:230,234`
**Issue:** `collection://list` calls `listCollections()` with no namespace argument (returns all namespaces' collections), and `collection://{name}` hardcodes `namespace = ... ?? 'global'` then ignores any provided namespace beyond that fallback path. The spec requires resource reads to respect namespace scoping and not return cross-namespace data unless explicitly requested.
**Why it matters:** Namespaces are the isolation boundary (`Memory.namespace`). A read resource that crosses namespaces by default leaks data between isolation scopes — a confidentiality concern in multi-client/multi-project deployments.
**Recommendation:** Default these resources to `config.defaults.namespace`, honor `?namespace=`, and pass it through to `listCollections(namespace)` and the collection-scoped query. Document whether categories are intentionally global; if so, state it in the spec, otherwise add namespace scoping.

## Maintainability & code quality

### [Medium · High · M] Fulltext rank is a constant, not a relevance score — `src/storage/sqlite.ts:571,577`
**Issue:** `fullTextSearch` selects `${terms.length} as rank` and pushes `rank: -terms.length` for every matching row, so all rows for a given query share the identical score. Downstream, fulltext mode normalizes to a single constant (`src/search/index.ts:97`) and RRF assigns fulltext ranks purely by SQL return order (`src/search/index.ts:139-144`).
**Why it matters:** The spec scenario "Fulltext mode returns lexical-ranked results … ranked by fulltext relevance score" is not satisfied — results are effectively unordered by relevance, and the hybrid blend's fulltext component is degenerate (order-of-insertion, not relevance).
**Recommendation:** Use FTS5 `bm25(memories_fts)` (or term-frequency counting) to produce a real per-row score and order by it. This also addresses #6.

### [Low · High · S] JSON-schema `recall.min_score` drifts from Zod — `src/tools/schemas.ts:33-34`
**Issue:** The advertised `inputSchema` for `recall` omits `min_score` entirely while the Zod `RecallInputSchema` defines `min(0).max(1).default(0.6)` (`src/domain/schemas.ts:45`). Clients reading the tool schema see an incomplete contract.
**Why it matters:** The JSON schema is the client-facing contract; drift from the enforcing Zod schema breaks the "responses/inputs match declared contracts" intent and can confuse client codegen.
**Recommendation:** Add `min_score` (with bounds/default) to the `recall` JSON schema, and consider generating the JSON schema from Zod to prevent future drift.

### [Low · Medium · S] Duplicated, brittle URI parsing — `src/resources/index.ts:21-22,41,202-203,226-227`
**Issue:** `host = url.hostname || url.pathname.replace('//','')` is copy-pasted in four places to work around `memory://list` style URIs where the "path" is parsed as a hostname. This is fragile and inconsistent (the `handle` dispatcher computes `host` but then re-derives it inside each sub-handler).
**Why it matters:** Maintainability; a URI edge case (e.g. uppercase host, trailing slash) must be fixed in multiple spots.
**Recommendation:** Extract a single `parseResourceUri(uri)` helper returning `{ scheme, path, searchParams }`.

## Testing & coverage

### [Medium · Medium · M] Missing per-tool contract tests for validation rejection — `src/tools/index.test.ts`
**Issue:** Task 3.3 calls for "contract tests for all tool schemas and error envelopes." Present coverage: `collections` delete semantics (`src/tools/index.test.ts`), one generic `remember` unknown-field rejection (`src/domain/schemas.test.ts:32`), import empty-content, and resource-side limit validation. There is no test asserting `INVALID_INPUT` for out-of-bounds/unknown fields on `recall`, `search`, `tag`, `category`, or `backup`, nor a test pinning each tool's success output shape.
**Why it matters:** The proposal's central value is a stable cross-client contract; without per-tool schema tests, schema regressions (e.g. an accidentally relaxed bound or an output field rename) ship undetected.
**Recommendation:** Add a table-driven test iterating every tool with an unknown field and an out-of-bounds value, asserting the `INVALID_INPUT` envelope; add at least one output-shape assertion per tool.

## Dependencies & supply chain

No issues found. The proposal introduces no new dependencies; it uses the existing MCP SDK request schemas, Zod, and sql.js/Qdrant already present in the project.

## Recommendations (prioritized)

1. **Fix namespace scoping on `collection://` (and decide category scoping)** — Medium security/spec drift; default to `config.defaults.namespace`, honor `?namespace=`, pass through to storage (`src/resources/index.ts:230,234`).
2. **Give fulltext a real relevance score via FTS5 `bm25`/`MATCH`** — resolves spec drift #1 and performance #6 together (`src/storage/sqlite.ts:556-577`).
3. **Make hybrid embedding-degradation observable** — log + metric (and ideally a response flag), then test it (`src/search/index.ts:125-127`).
4. **Add per-tool contract tests** (unknown-field + out-of-bounds + output shape) to fully satisfy Task 3.3 (`src/tools/index.test.ts`).
5. **Close JSON-schema/Zod drift** on `recall.min_score` and consider generating tool JSON schemas from Zod to prevent recurrence (`src/tools/schemas.ts:33`).
6. **Extract a shared resource-URI parser** to remove the duplicated `hostname || pathname` workaround (`src/resources/index.ts`).
7. **Paginate/query-scope `collection://{name}`** instead of fetch-50-then-filter (`src/resources/index.ts:234-237`).
