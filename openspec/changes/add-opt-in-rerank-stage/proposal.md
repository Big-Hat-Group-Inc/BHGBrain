## Why

`recall` orders its results by a single retrieval-time signal: cosine similarity,
optionally reshaped by the composite prior (`SearchService.compositeScore`,
`src/search/index.ts:312-330`) and gated by `min_score` (`src/tools/index.ts:202`).
Every one of those signals is computed from the query embedding alone — nothing ever
looks at the *candidate text* and the *query text* together. Embedding similarity is a
coarse proxy for relevance: it reliably narrows millions of memories down to a
plausible top 20, but it routinely misorders that top 20, ranking a topically-adjacent
but wrong memory above the one that actually answers the query.

`handleRecall` (`src/tools/index.ts:156-205`) already over-fetches a candidate pool
(`fetchLimit = min(limit * 2, 40)`) beyond what it returns (`limit`, default 5, max
20) — the exact "fetch ~20, return ~5" shape a rerank pass wants, already present in
the code, unused for anything beyond expiry-safety margin. There is no stage today
that spends extra compute per query to re-judge those ~20 candidates against the
actual query text; `codeaudit/storagefeaturebrainstorm.md` item 1.7 identifies this
gap explicitly and calls it a "medium effort, high precision gain" opt-in addition.

`pipeline.extraction_enabled` / `extraction_model` / `extraction_model_env`
(`src/config/index.ts:212-214`) already establish a project convention for
config-gated, model-backed stages that ship as inert defaults on stock installs — but
that hook is itself still unimplemented (`src/pipeline/index.ts:60-71`: "v1 extraction
is deterministic and single-candidate only, regardless of `pipeline.extraction_enabled`
... the config knob is reserved for a future model-backed extraction stage"). A rerank
stage should not be blocked on that hook landing; it needs its own config block and its
own model/key resolution, wired directly at the call site.

## What Changes

- Add a `search.rerank` config block (Zod schema, `src/config/index.ts` next to
  `search.ranking`, lines 157-178): `enabled` (default `false`), `provider` (enum,
  default `"openai"`, reserved for a future local option), `candidate_pool` (default
  `20`), `model` (default `"gpt-4o-mini"`), `model_env` (default
  `"BHGBRAIN_RERANK_API_KEY"`), `timeout_ms` (default `3000`).
- Add a `RerankProvider` abstraction (`src/rerank/index.ts`, new file) with an
  `OpenAiRerankProvider` implementation: one batched chat-completions call per recall
  scoring every candidate in the pool 0-1 against the query, reusing the `fetch`-based
  HTTP pattern already used by `OpenAIEmbeddingProvider`
  (`src/embedding/index.ts:87-105`) — no new npm dependency.
- Wire the provider at bootstrap (`src/index.ts`, next to `embeddingBreaker` /
  `qdrantBreaker`, lines 63-68) behind its own `CircuitBreaker` (key `'rerank'`), and
  pass it into `SearchService` as a new optional constructor dependency.
- Add `SearchService.rerank(query, candidates, poolSize)`: scores the top
  `candidate_pool` composite-ranked candidates, replaces their `score` with the
  clamped LLM score, and re-sorts. Any candidate the LLM response omits or scores
  invalidly keeps its pre-rerank score rather than being dropped. Any provider
  failure, timeout, or malformed response degrades to pre-rerank ordering — the same
  observable-degradation pattern `hybridSearch` already uses for embedding outages
  (`src/search/index.ts:213-237`): a `search_rerank_degraded` counter and a
  structured warn log, never a thrown error.
- Call the new stage from `handleRecall` only (`src/tools/index.ts:156-205`), after
  the existing defensive type/tag re-check and before `min_score` filtering, gated on
  `config.search.rerank.enabled`. `search`/`memory://inject` are unaffected.
- Add `rerank_score?: number` to `SearchResult` (`src/domain/types.ts:84-108`) so
  callers can see the raw LLM judgment; `semantic_score` is left untouched, so
  `min_score` filtering (which reads `semantic_score ?? score`) is provably
  unaffected by reranking, exactly as composite ranking already guarantees for its own
  score adjustment.
- Document the config block, the new `BHGBRAIN_RERANK_API_KEY` environment variable,
  and the recall flow change in `README.md` + the four translations, `.env.example`,
  and bump `package.json` version.

## Capabilities

### New Capabilities
- `recall-rerank`: `recall` can optionally re-score its candidate pool with an LLM
  relevance judgment before applying `min_score` and truncating to `limit`, replacing
  pure embedding-similarity ordering with LLM-judged relevance for that pool. Disabled
  by default; degrades gracefully to today's behavior on any failure.

### Modified Capabilities

(none — `recall`'s existing filter/threshold/limit semantics are unchanged; the new
stage is additive and default-off.)

## Impact

- Affected code: `src/config/index.ts` (new `search.rerank` schema), `src/rerank/index.ts`
  (new provider module), `src/index.ts` (bootstrap wiring), `src/search/index.ts`
  (`SearchService.rerank`), `src/tools/index.ts` (`handleRecall`), `src/domain/types.ts`
  (`SearchResult.rerank_score`), co-located tests.
- Behavior: with `search.rerank.enabled: false` (the default), `recall` is
  byte-for-byte unchanged — no new network call, no new required dependency, no
  ordering change. With it enabled, `recall` makes one additional LLM call per
  invocation, ordering within the reranked pool changes to reflect the LLM's
  relevance judgment, and `min_score` membership is unaffected (still gated on
  `semantic_score`).
- Docs: README ×5, `.env.example` (`BHGBRAIN_RERANK_API_KEY`), version bump.
- Depends on: nothing. Explicitly does **not** depend on `add-multi-candidate-extraction`
  (a separate, not-yet-built proposal) landing first — `pipeline.extraction_model`/
  `extraction_model_env` are a different, still-unimplemented reserved hook; this
  change defines and resolves its own independent `search.rerank.model`/`model_env`
  and never reads the `pipeline.*` fields.
