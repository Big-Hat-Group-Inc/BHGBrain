## 1. Config schema

- [ ] 1.1 Add `search.query_expansion` to the Zod config schema
  (`src/config/index.ts`, alongside the existing `search.ranking` block at
  lines 166-177): `enabled` (default `true`), `max_variants` (int, 1-5, default `2`),
  `keyword_stripped` (default `true`), and a nested `llm_paraphrase` object:
  `enabled` (default `false`), `mode` (`'paraphrase' | 'hyde'`, default
  `'paraphrase'`), `variant_count` (int, 1-3, default `2`), `timeout_ms` (positive
  int, default `3000`).
- [ ] 1.2 Document the block in `README.md`'s config reference (near the existing
  `search.ranking` documentation) and confirm no new env var is needed beyond the
  existing `pipeline.extraction_model_env` / `OPENAI_API_KEY` fallback (task 5.2).

## 2. Phase 1: keyword-stripped variant (no model)

- [ ] 2.1 Create `src/search/query-expansion.ts` with a small fixed English stopword
  set and `keywordStrippedVariant(query: string): string | null`, returning `null`
  when the stripped result is empty/whitespace-only or identical (case-insensitively)
  to the trimmed original.
- [ ] 2.2 Add `buildVariants(query: string, config: BrainConfig['search']['query_expansion'], llmVariants?: string[]): string[]` in the
  same module: starts with the trimmed original, appends the keyword-stripped variant
  (if `keyword_stripped` is true and `keywordStrippedVariant` returns non-null) and
  any provided `llmVariants`, dedupes case-insensitively, and truncates to
  `max_variants`.
- [ ] 2.3 Unit tests in `src/search/query-expansion.test.ts`: stopword stripping
  produces the expected variant; all-stopword query returns `null`; all-content-word
  query returns `null` (no-op guard); dedup collapses a paraphrase identical to the
  original or the keyword variant; `max_variants` truncates correctly; disabling
  `keyword_stripped` yields only the original.

## 3. Wire phase 1 into SearchService

- [ ] 3.1 In `semanticSearch` (`src/search/index.ts:137-168`), when
  `config.search.query_expansion.enabled`, replace the single
  `this.embedding.embed(query)` (line 146) with `buildVariants(...)` +
  `this.embedding.embedBatch(variants)`, then run `storage.qdrant.search(...)` once
  per resulting vector (in parallel via `Promise.all`), merge the per-variant result
  arrays by `id` keeping the max `score` per id, sort descending, and slice to
  `limit` before passing into `buildSearchResults` — same call shape/return type as
  today when `enabled` is `false` or only one variant is produced.
  Cross-device Qdrant-payload fallback (`qdrantPayload`, used by
  `buildResultFromQdrantPayload`) must be preserved on whichever merged entry wins.
- [ ] 3.2 In `hybridSearch` (`src/search/index.ts:192-283`), apply the same
  variant-embed-and-merge treatment to the semantic leg only (lines 213-225): build
  variants, `embedBatch`, run one `storage.qdrant.search` per vector in parallel,
  merge by id keeping max score (and the `vector` field when `withVectors` is set,
  from whichever variant produced the winning score) before feeding
  `semanticItems` into the existing RRF fusion (lines 241-249) unchanged. The
  fulltext leg (lines 209-211, 251-256) is untouched — single `query` string only.
- [ ] 3.3 Add a `recordHistogram('search_query_expansion_variant_count', n)` call
  (mirroring the existing `search_total_ms` pattern at
  `src/search/index.ts:133`) so operators can observe how many variants a call
  actually used.
- [ ] 3.4 Confirm `handleRecall` (`src/tools/index.ts:156-205`) and `handleSearch`
  (`src/tools/index.ts:224-237`) need no changes — they call `search()`/rely on its
  `limit`-bounded return, which is preserved by task 3.1/3.2's merge-then-slice step.

## 4. Phase 1 tests

- [ ] 4.1 `semanticSearch` test: a query whose keyword-stripped variant surfaces a
  memory the literal query's embedding alone would miss (mock `embedBatch` /
  `qdrant.search` to return variant-specific candidates) appears in the result set.
- [ ] 4.2 Merge test: a memory id present in both variants' results keeps its max
  score, not a summed or averaged one.
- [ ] 4.3 Limit test: with two variants each returning up to `limit` distinct
  candidates, the final result count is still bounded by `limit`.
- [ ] 4.4 Kill-switch test: `search.query_expansion.enabled: false` calls
  `embedding.embed`/embeds a single variant exactly as before this change (assert
  `embedBatch` is called with a one-element array or `embed` is called directly,
  whichever the implementation uses on the disabled path).
- [ ] 4.5 `hybridSearch` test: semantic-leg expansion merges into RRF the same way;
  fulltext leg is called exactly once with the original query (assert
  `fullTextSearch` mock call count/args unchanged from pre-change behavior).
- [ ] 4.6 Regression: existing `min_score` and composite-ranking tests in
  `src/search/index.test.ts` (`describe('composite ranking ...')`,
  `describe('push-down-recall-filters: filter plumbing')`) continue to pass
  unmodified with `query_expansion.enabled` at its default.

## 5. Phase 2: LLM paraphrase / HyDE (config + key gated)

- [ ] 5.1 Create `LLMQueryExpansionProvider` in `src/search/query-expansion.ts` (or a
  co-located `llm-provider.ts` if the file grows large): raw-`fetch` client against
  the OpenAI-compatible Chat Completions endpoint, modeled on
  `OpenAIEmbeddingProvider`'s fetch/parse/error pattern
  (`src/embedding/index.ts:37-` for auth-header and error-shape conventions).
  Constructor takes `config.pipeline.extraction_model` and resolves the API key from
  `process.env[config.pipeline.extraction_model_env]`, falling back to
  `process.env.OPENAI_API_KEY` when unset (implementing the fallback `README.md:519`
  already documents but no code currently does). No key resolvable → provider reports
  itself unconfigured (a boolean/getter, not a thrown error) rather than throwing at
  construction, since phase 2 must be optional at runtime, not fatal at startup.
- [ ] 5.2 Implement `generateVariants(query: string, mode: 'paraphrase' | 'hyde', count: number, timeoutMs: number): Promise<string[]>`
  using `AbortController` for the timeout; on any failure (non-2xx, network error,
  timeout, malformed response) return `[]` rather than throwing, and increment
  `incCounter('search_query_expansion_llm_degraded')` + `logger.warn({...})`
  (mirroring the existing `search_embedding_degraded` pattern at
  `src/search/index.ts:226-238`) at the call site.
- [ ] 5.3 Wrap the provider's fetch in its own `CircuitBreaker` (`key: 'extraction'`),
  constructed alongside `embeddingBreaker`/`qdrantBreaker` in `src/index.ts:63-65`
  and passed to `SearchService`'s constructor.
- [ ] 5.4 Thread an optional `queryExpansion?: LLMQueryExpansionProvider` dependency
  through `SearchService`'s constructor (`src/search/index.ts:69-80`) and wire it at
  `src/index.ts:104`. When `config.search.query_expansion.llm_paraphrase.enabled` is
  true and the provider reports itself configured, call `generateVariants` and pass
  its output into `buildVariants` (task 2.2) as `llmVariants`; otherwise behave
  exactly as phase 1.
- [ ] 5.5 Startup-time visibility: if `llm_paraphrase.enabled` is true but no key
  resolves, log once at startup (mirroring `warnIfEmbeddingDegraded`,
  `src/index.ts:69`) rather than emitting per-call warnings for a static
  misconfiguration.

## 6. Phase 2 tests

- [ ] 6.1 `generateVariants` unit tests (mocked `fetch`): success returns the
  expected paraphrase/HyDE strings; non-2xx response returns `[]`; timeout (mock a
  never-resolving fetch, assert abort fires at `timeout_ms`) returns `[]`; malformed
  JSON response returns `[]` without throwing.
- [ ] 6.2 Missing-key test: no `extraction_model_env` value and no `OPENAI_API_KEY`
  set → provider reports unconfigured, `SearchService` skips LLM expansion silently
  (no per-call warning, no thrown error).
- [ ] 6.3 `OPENAI_API_KEY` fallback test: `extraction_model_env`-named variable unset
  but `OPENAI_API_KEY` set → provider resolves the key and is configured.
- [ ] 6.4 Integration test in `src/search/index.test.ts`: with `llm_paraphrase.enabled`
  and a mock provider returning 2 paraphrases, `semanticSearch`/`hybridSearch`
  produce a result set reflecting the union of the original, keyword, and LLM
  variants, capped by `max_variants`.
- [ ] 6.5 Degrade test: mock provider throwing/timing out mid-call still returns a
  valid result set built from phase-1 variants only, with
  `search_query_expansion_llm_degraded` incremented and no unhandled rejection.

## 7. Docs and validation

- [ ] 7.1 Document `search.query_expansion` (both phases) in `README.md`'s config
  reference section and `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md`, mirroring section-for-section.
- [ ] 7.2 Update the `BHGBRAIN_EXTRACTION_API_KEY` row in `README.md`'s environment
  variables table (`README.md:519`) to describe multi-query expansion as a live
  consumer (not just "future use") once phase 2 lands, and note the `OPENAI_API_KEY`
  fallback is now implemented.
- [ ] 7.3 Update `AGENTS.md`'s "Config vs. environment" section if the
  `extraction_model_env` bullet (`AGENTS.md:136`) needs to note the new fallback
  behavior.
- [ ] 7.4 Bump `package.json` `version` (currently `1.11.0`).
- [ ] 7.5 Run `npm run lint && npm test`; both must pass before this change is
  considered done.
