## 1. Config schema

- [x] 1.1 Add a `search.rerank` block to the Zod config schema
  (`src/config/index.ts`, inside `search: z.object({...})`, alongside `hybrid_weights`
  and `ranking` at lines 157-178): `enabled` (`z.boolean().default(false)`),
  `provider` (`z.enum(['openai']).default('openai')`), `candidate_pool`
  (`z.number().int().min(1).max(50).default(20)`), `model` (`z.string().default('gpt-4o-mini')`),
  `model_env` (`z.string().default('BHGBRAIN_RERANK_API_KEY')`), `timeout_ms`
  (`z.number().int().positive().default(3000)`).
- [x] 1.2 Confirm no other config consumer needs updating — check for exhaustive
  `search` object destructuring or serialization elsewhere (e.g. `ensureDataDir`'s
  `JSON.stringify(config, ...)` in `src/config/index.ts:371` needs no change, it
  serializes the whole object).

## 2. Rerank provider

- [x] 2.1 Create `src/rerank/index.ts` with a `RerankProvider` interface —
  `score(query: string, candidates: Array<{ id: string; text: string }>): Promise<Map<string, number>>`
  — mirroring the shape of `EmbeddingProvider` (`src/embedding/index.ts:25-35`).
- [x] 2.2 Implement `OpenAiRerankProvider`: one batched chat-completions POST per
  call, JSON response format requesting `{"scores": [{"id": string, "score": number}]}`,
  reusing the circuit-breaker-wrapped `fetch` pattern from
  `OpenAIEmbeddingProvider.requestEmbeddings` (`src/embedding/index.ts:87-105`) — same
  `Authorization`/`Content-Type` headers, same `breaker.execute(...)` wrapping. Read
  the API key from `process.env[config.search.rerank.model_env]`; throw a constructor
  error with the same `Missing environment variable: ...` message shape
  `OpenAIEmbeddingProvider` uses (`src/embedding/index.ts:53-57`) when absent.
- [x] 2.3 Apply `AbortController`-based timeout using `config.search.rerank.timeout_ms`.
- [x] 2.4 Validate the response: parse with a Zod schema
  (`z.object({ scores: z.array(z.object({ id: z.string(), score: z.number() })) })`),
  clamp each `score` to `[0, 1]`, and build the returned `Map` only from entries whose
  `id` matches a requested candidate. Candidates absent from a valid response, or the
  whole call failing validation, are simply absent from the returned `Map` — the
  caller (task 4) is responsible for keeping those candidates at their pre-rerank
  score rather than dropping them.
- [x] 2.5 Add a `DegradedRerankProvider` (or equivalent no-op) returned when
  `search.rerank.enabled` is true but the API key is missing at startup — mirrors
  `DegradedEmbeddingProvider` (`src/embedding/index.ts:127+`): `score()` always
  rejects, so the caller's existing degrade-on-error path (task 4.4) handles it
  without a separate code path.

## 3. Bootstrap wiring

- [x] 3.1 In `src/index.ts`, next to `embeddingBreaker`/`qdrantBreaker`
  (lines 63-68), construct `const rerankBreaker = new CircuitBreaker({ ...breakerOptions, key: 'rerank', logger })`.
- [x] 3.2 Instantiate a `RerankProvider` only when `config.search.rerank.enabled` is
  true (via a `createRerankProvider(config, { breaker: rerankBreaker, metrics })`
  factory in `src/rerank/index.ts`, mirroring `createEmbeddingProvider`'s shape in
  `src/embedding/index.ts`); log a startup warning (mirroring
  `warnIfEmbeddingDegraded`, `src/index.ts:69`) if the configured `model_env` has no
  value, and fall back to the degraded provider from task 2.5 rather than throwing.
- [x] 3.3 Pass the (possibly undefined, when disabled) `RerankProvider` into
  `new SearchService(config, storage, embedding, metrics, logger)`
  (`src/index.ts:104`) as a new optional constructor parameter.
- [x] 3.4 Add `rerankBreaker` to the `HealthService` breakers map
  (`src/index.ts:106-109`) only when a live (non-degraded) provider was constructed,
  so `health://status` reports it exactly when reranking is actually configured.

## 4. SearchService + handleRecall integration

- [x] 4.1 Add `SearchService.rerank(query: string, results: SearchResult[], poolSize: number): Promise<SearchResult[]>`
  in `src/search/index.ts`, alongside `compositeScore`/`buildSearchResults`
  (near line 330): takes the top `poolSize` of `results` (already composite-ranked),
  calls the injected `RerankProvider.score(query, candidates)` with each candidate's
  `id`/`content`, and for every candidate with a returned score, sets
  `rerank_score` and overwrites `score` with the clamped value. Candidates outside the
  pool, or omitted from the response, keep their existing `score` and no
  `rerank_score`. Returns the full list re-sorted by `score` descending.
- [x] 4.2 Add `rerank_score?: number` to the `SearchResult` interface
  (`src/domain/types.ts:84-108`), documented as populated only when reranking ran on
  that candidate — same "absent, not `false`/`null`" convention `archived` and
  `vector` already use on that interface.
- [x] 4.3 In `handleRecall` (`src/tools/index.ts:156-205`): when
  `ctx.config.search.rerank.enabled`, compute `fetchLimit` as
  `Math.min(Math.max(input.limit * 2, ctx.config.search.rerank.candidate_pool), 40)`
  instead of the current `Math.min(input.limit * 2, 40)` (line 174); after the
  existing defensive type/tag re-check (lines 185-195) and before the `min_score`
  filter (line 202), call `filtered = await ctx.search.rerank(input.query, filtered, ctx.config.search.rerank.candidate_pool)`.
- [x] 4.4 Wrap the `SearchService.rerank` call's provider interaction in try/catch:
  on any error (thrown by the provider, timeout, or the degraded no-op provider),
  `ctx.metrics.incCounter('search_rerank_degraded')`,
  `ctx.logger.warn({ event: 'rerank_degraded', message: ... })` (matching the shape of
  the `embedding_degraded` warn in `src/search/index.ts:232-236`), and return the
  pre-rerank `results` unchanged — `handleRecall` must not throw because reranking
  failed.
- [x] 4.5 Confirm `handleSearch` (`src/tools/index.ts:224-237`) and
  `SearchService.searchForInject` (`src/search/index.ts:293-300`) are unmodified —
  reranking is not wired into either in this change.

## 5. Tests

- [x] 5.1 `src/rerank/index.test.ts` (new): `OpenAiRerankProvider` sends the expected
  request shape, parses a valid response into the expected `Map`, clamps
  out-of-range scores, drops unmatched ids, and rejects on non-2xx / timeout /
  malformed JSON.
- [x] 5.2 `src/search/index.test.ts`: `SearchService.rerank` replaces `score` and sets
  `rerank_score` only for candidates within `poolSize` that the provider scored;
  candidates outside the pool or unscored by a partial response keep their original
  `score` and no `rerank_score`; the returned list is re-sorted by `score`.
  Follow the existing `createSearchService` test-harness pattern already used for the
  hybrid-degradation test (`src/search/index.test.ts:339-350`).
- [x] 5.3 `src/tools/index.test.ts`: `handleRecall` with `search.rerank.enabled: true`
  calls `ctx.search.rerank` with the reranked candidate pool and applies `min_score`/
  `limit` to the reranked list; with `enabled: false` (default), `ctx.search.rerank`
  is never called and behavior is byte-for-byte identical to before this change
  (regression test using the existing `handleRecall` test fixtures, e.g. around
  `src/tools/index.test.ts:777-796`).
- [x] 5.4 `src/tools/index.test.ts`: rerank provider failure (mocked rejection) does
  not throw from `handleRecall`, increments `search_rerank_degraded`, and returns the
  pre-rerank ordering.
- [x] 5.5 `src/config/index.test.ts`: `search.rerank` defaults parse
  (`enabled: false`, `provider: 'openai'`, `candidate_pool: 20`, `model: 'gpt-4o-mini'`,
  `model_env: 'BHGBRAIN_RERANK_API_KEY'`, `timeout_ms: 3000`), and out-of-range
  overrides (e.g. `candidate_pool: 0` or `51`) fail validation.
- [ ] 5.6 `src/index.test.ts` (or equivalent bootstrap test, if one exists for
  embedding wiring): rerank provider is not constructed, and `rerankBreaker` is not
  added to the health breakers map, when `search.rerank.enabled` is false.
  LEFT UNCHECKED (2026-08-28): no `src/index.test.ts` exists, and no "equivalent
  bootstrap test... for embedding wiring" exists either — `main()` in `src/index.ts`
  is untested end-to-end (unexported, directly instantiates real SqliteStore/
  QdrantStore/etc.), so the task's stated premise ("if one exists") doesn't hold.
  Building a harness from scratch to cover just this one conditional would mean
  mocking every dependency `main()` touches — disproportionate to the change. The
  conditional itself (`rerank` only constructed / `rerankBreaker` only added to
  `healthBreakers` when `config.search.rerank.enabled`) is a straight `if` mirroring
  the existing `summarizationBreaker` pattern one block above it in `src/index.ts`;
  reviewed by inspection rather than by a new test file.

## 6. Docs

- [x] 6.1 Document the `search.rerank` config block in `README.md`'s Configuration
  JSON example (near the `search.ranking` block, `README.md:414-439`), and add a short
  "Rerank" subsection near "Composite Ranking" (`README.md:1616-1642`) explaining the
  opt-in stage, its default-off posture, and its interaction with `min_score`
  (unaffected — still gated on `semantic_score`).
- [x] 6.2 Add `BHGBRAIN_RERANK_API_KEY` to the Environment Variables table
  (`README.md:512-519`), following the same row shape as
  `BHGBRAIN_EXTRACTION_API_KEY` but noting it has **no** fallback to
  `OPENAI_API_KEY` — the rerank stage requires its own key when enabled.
- [x] 6.3 Add a `BHGBRAIN_RERANK_API_KEY` entry to `.env.example`, modeled on the
  existing `BHGBRAIN_EXTRACTION_API_KEY` block (`.env.example:26-28`).
- [x] 6.4 Mirror 6.1/6.2 into `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md`, section-for-section.
- [x] 6.5 Bump `package.json` `version` (currently `1.11.0` — this is a user-visible
  change: new tool behavior when opted in, new env var, new config fields).

## 7. Validation

- [x] 7.1 `npm run lint` (type check + eslint, including
  `@typescript-eslint/no-explicit-any` on the new `src/rerank/index.ts` module and its
  response-parsing code).
- [x] 7.2 `npm test`.
- [ ] 7.3 Manual smoke check (optional but recommended): set
  `search.rerank.enabled: true` and `BHGBRAIN_RERANK_API_KEY` locally, run a `recall`
  call, and confirm `rerank_score` appears on results and ordering reflects it; then
  disable and confirm the response is unchanged from pre-change behavior.
  LEFT UNCHECKED (2026-08-28): explicitly "optional" per its own wording, and requires
  a live OpenAI API key plus a running Qdrant/SQLite-backed server not available in
  this sandbox. Unit/integration coverage (tasks 5.1-5.5) exercises the same request
  shape, response parsing, degrade path, and `handleRecall` wiring against a mocked
  `fetch`, so the behavior is verified short of a real network call.
