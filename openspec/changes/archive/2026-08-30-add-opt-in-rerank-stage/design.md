## Context

`handleRecall` (`src/tools/index.ts:156-205`) already shapes the right pipeline for a
rerank stage without meaning to:

1. It computes `fetchLimit = Math.min(input.limit * 2, 40)` (line 174) — a candidate
   pool larger than what it returns.
2. It calls `SearchService.search(..., 'semantic', fetchLimit, ...)` (line 177), which
   internally applies the composite ranking prior in `buildSearchResults`
   (`src/search/index.ts:332-392`) and returns results already sorted by
   `relevance × prior`.
3. Back in `handleRecall`, a defensive type/tag re-check runs (lines 185-195), then
   `min_score` filters on `semantic_score ?? score` (line 202), then the list is
   sliced to `input.limit` (line 204).

Nothing between steps 2 and 4 ever looks at query text vs. candidate text together —
every signal so far is either cosine similarity or metadata (`importance`,
`access_count`, `updated_at`). `codeaudit/storagefeaturebrainstorm.md` item 1.7 names
this gap and proposes a rerank pass over the top ~20 candidates before returning the
top 5, explicitly opt-in ("config-gated the same way extraction is meant to be").

The precedent it points to — `pipeline.extraction_enabled` / `extraction_model` /
`extraction_model_env` (`src/config/index.ts:212-214`) — is itself unimplemented: `extract()`
in `src/pipeline/index.ts:61-78` is deterministic, single-candidate, and explicitly
ignores `extraction_enabled`. That hook is reserved for a *different* future change
(`add-multi-candidate-extraction`, not yet proposed as of this writing). Reusing its
config fields, or waiting on it, would tie an unrelated, independently-valuable
feature to unfinished work. This change gives reranking its own `search.rerank.*`
config block instead.

## Goals / Non-Goals

Goals:
- Add an opt-in stage that re-scores `recall`'s candidate pool by sending the query and
  candidate text to an LLM, which returns a 0-1 relevance judgment per candidate.
- Ship fully inert on stock installs: `search.rerank.enabled: false` by default, zero
  new network calls, zero new required npm dependencies when disabled.
- Bound the added latency/cost to one batched call per recall, not one call per
  candidate.
- Degrade gracefully — any rerank failure (timeout, network error, malformed response,
  circuit open) falls back to pre-rerank ordering; a `recall` call that would have
  succeeded before this change still succeeds.
- Leave `min_score` filtering semantics (applies to `semantic_score`) and result
  membership for non-reranked callers completely unaffected.

Non-Goals:
- **Not dependent on `add-multi-candidate-extraction`.** That proposal (not yet
  created) would finish the reserved `pipeline.extraction_*` hook described above.
  This change does not read `pipeline.extraction_model` / `extraction_model_env`, does
  not wait for that hook to be implemented, and ships a fully working rerank stage
  regardless of whether that other proposal ever lands. The only thing the two share is
  the general shape of "config-gated, model-backed, opt-in" — not code, not config
  fields, not sequencing.
- **No local cross-encoder in v1.** The brainstorm entry offers "LLM scoring... or a
  local cross-encoder" as alternatives. A local cross-encoder means bundling or
  downloading a model file and an inference runtime (e.g. ONNX Runtime) — a much
  larger dependency-footprint decision that conflicts with "stock installs stay
  dependency-free" if it is not carefully optional. `search.rerank.provider` is added
  as an enum (`"openai"` only for now) specifically so a `"local"` value can be added
  later without a breaking config change, but no local implementation ships here.
- **Not applied to `search` or `memory://inject`.** `handleRecall`'s existing
  fetch-more/slice-down shape is what makes this a small, additive change; `search`
  (`src/tools/index.ts:224-237`) returns exactly `limit` candidates with no over-fetch
  margin, and `searchForInject` (`src/search/index.ts:293-300`) is on a latency-
  sensitive resource-read path. Extending reranking to either is a plausible follow-up,
  not part of this change.
- **No blending with the composite prior.** The rerank score replaces `score` for
  reranked candidates rather than being combined with the importance/access/decay
  prior; mixing an LLM relevance judgment with metadata-derived priors is a separate
  design question left for a future change if the replace-only behavior proves too
  blunt.
- **No change to `min_score`'s target field.** It keeps applying to `semantic_score`,
  never to `rerank_score` or the post-rerank `score`.

## Decisions

- **Config shape** (`src/config/index.ts`, new block inside `search`, alongside
  `hybrid_weights`/`ranking` at lines 157-178):
  ```ts
  rerank: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(['openai']).default('openai'),
    candidate_pool: z.number().int().min(1).max(50).default(20),
    model: z.string().default('gpt-4o-mini'),
    model_env: z.string().default('BHGBRAIN_RERANK_API_KEY'),
    timeout_ms: z.number().int().positive().default(3000),
  }).default({}),
  ```
  `model_env` follows the same indirection as `embedding.api_key_env` and
  `pipeline.extraction_model_env`: the config stores the *name* of the env var, never
  the secret. Defaulting to a dedicated `BHGBRAIN_RERANK_API_KEY` (rather than falling
  back to `OPENAI_API_KEY` implicitly) means enabling reranking is a deliberate,
  separately-keyed opt-in — it cannot silently start consuming the embedding
  provider's key/budget.

- **Provider abstraction** (`src/rerank/index.ts`, new file): a small interface
  mirroring `EmbeddingProvider`'s shape —
  ```ts
  interface RerankProvider {
    readonly provider: string;
    score(query: string, candidates: Array<{ id: string; text: string }>): Promise<Map<string, number>>;
  }
  ```
  `OpenAiRerankProvider` sends one chat-completions request per call (JSON response
  format: `{"scores": [{"id": "...", "score": 0.0-1.0}, ...]}`), reusing the
  `fetch`-based HTTP call pattern `OpenAIEmbeddingProvider.requestEmbeddings` already
  established (`src/embedding/index.ts:87-105`) — same header shape, same
  circuit-breaker-wrapped `fetch`, no SDK dependency added. Response parsing validates
  each entry's `id` against the candidate set and clamps `score` to `[0, 1]`;
  candidates missing from the response, or with an unparseable score, keep their
  pre-rerank score rather than being dropped — a partial/malformed LLM response
  degrades the *ranking*, never the *result set*.

- **Bootstrap wiring** (`src/index.ts`, next to `embeddingBreaker`/`qdrantBreaker`,
  lines 63-68): a `rerankBreaker = new CircuitBreaker({ ...breakerOptions, key:
  'rerank', logger })` is always constructed (cheap, stateless until used), but the
  `RerankProvider` itself is only instantiated when `config.search.rerank.enabled` —
  an unset/invalid `BHGBRAIN_RERANK_API_KEY` with reranking enabled logs a startup
  warning (same shape as `warnIfEmbeddingDegraded`) and reranking becomes a no-op
  (always degrades) rather than crashing startup. `rerankBreaker` is added to the
  `HealthService` breakers map (`Record<string, CircuitBreaker>`,
  `src/health/index.ts:20`) only when constructed, so `health://status` reports it
  exactly when it exists.

- **Where the stage runs**: `SearchService.rerank(query, results, poolSize)`, a new
  method alongside `compositeScore`/`buildSearchResults`, called only from
  `handleRecall` (`src/tools/index.ts:156-205`) — not folded into `search()` — so
  `search()`'s signature, and every other caller of it
  (`handleSearch`, `searchForInject`), stay byte-for-byte unchanged. Sequencing inside
  `handleRecall`:
  1. `fetchLimit` becomes `Math.min(Math.max(input.limit * 2, config.search.rerank.candidate_pool), 40)`
     when reranking is enabled, so the store fetch already returns enough candidates
     to make the rerank pool meaningful even for `limit: 1`.
  2. The existing defensive type/tag re-check runs unchanged.
  3. If enabled, `ctx.search.rerank(input.query, filtered, config.search.rerank.candidate_pool)`
     scores the top `candidate_pool` of the (already composite-ranked) list, replaces
     `score` with the clamped rerank score for scored candidates, sets `rerank_score`,
     and re-sorts the full list by `score` descending.
  4. `min_score` filtering and the final `slice(0, input.limit)` run exactly as today,
     against `semantic_score ?? score` — untouched by step 3.

- **Failure handling**: identical shape to `hybridSearch`'s embedding-degradation path
  (`src/search/index.ts:213-237`) — wrap the provider call (network error, non-2xx,
  `AbortController` timeout at `timeout_ms`, or circuit-open) in try/catch,
  `metrics.incCounter('search_rerank_degraded')`, `logger.warn({event:
  'rerank_degraded', ...})`, and return the pre-rerank list unchanged. `recall` never
  fails because reranking failed.

- **New field, not a replaced one**: `SearchResult.rerank_score?: number`
  (`src/domain/types.ts:84-108`) is additive, following the same pattern
  `searchForInject`'s `vector` field and `include_archived`'s `archived` field already
  use — `undefined` for every existing caller and for every result reranking did not
  touch, so it never appears in responses unless reranking actually ran on that
  candidate.

## Risks / Trade-offs

- **Latency**: one extra network round trip per recall when enabled (typically
  hundreds of ms to a few seconds for a ~20-candidate batch). Mitigated by batching
  into a single call, a configurable `timeout_ms` (default 3000ms) after which the
  stage degrades rather than blocking, and an off-by-default posture.
- **Cost**: an LLM call per recall when enabled, on top of the existing embedding call.
  Purely operator opt-in and documented; `candidate_pool` bounds the token count per
  call.
- **Prompt-injection surface**: candidate memory content is sent to an LLM as part of
  the rerank prompt, and the LLM's output is parsed back into scores. The response
  schema is validated strictly (id + numeric score in `[0,1]`) and never
  interpolated, executed, or used to alter anything other than that candidate's own
  `score` — so a memory engineered to contain adversarial instructions can, at worst,
  skew its own rerank score, not exfiltrate other candidates' content or affect
  unrelated calls.
- **Non-determinism**: LLM-scored ordering can vary between otherwise-identical calls,
  unlike the fully deterministic composite-ranking path. This is an accepted trade-off
  of the opt-in precision gain; the default (`enabled: false`) keeps the deterministic
  path as-is.
- **Dedicated key requirement**: requiring `BHGBRAIN_RERANK_API_KEY` (rather than
  reusing `OPENAI_API_KEY`) is a small onboarding friction for operators who want to
  turn this on, in exchange for not silently coupling reranking spend to the embedding
  key/budget. Documented in README + `.env.example`.
