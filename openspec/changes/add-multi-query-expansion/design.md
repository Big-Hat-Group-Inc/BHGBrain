## Context

`SearchService.semanticSearch` (`src/search/index.ts:137-168`) embeds `query` once
(line 146) and issues one `storage.qdrant.search(...)` call (lines 153-155).
`hybridSearch` (`src/search/index.ts:192-283`) does the same for its semantic leg
(embed at line 214, search at lines 219-224) before RRF-fusing with the fulltext leg
and slicing to `limit` (line 275: `scored.slice(0, limit)`). Both feed
`buildSearchResults` (line 332), which hydrates rows, drops expired memories, applies
composite ranking (`compositeScore`, line 312, from `add-composite-recall-ranking`),
and re-sorts. `handleRecall` (`src/tools/index.ts:156-205`) calls `search()` in
`'semantic'` mode with a filter and a `fetchLimit` over-fetch, then applies `min_score`
against `semantic_score` (line 202) and slices to `input.limit` (line 204).

`EmbeddingProvider.embedBatch` (`src/embedding/index.ts:32`) already accepts multiple
strings in one call — `OpenAIEmbeddingProvider.embed()` is implemented as
`embedBatch([text])[0]` (lines 60-63) — so batching variant embeds costs one HTTP
round trip, not N.

`pipeline.extraction_model` / `extraction_model_env` (`src/config/index.ts:211-216`)
are validated config fields with no reader anywhere in `src/`.
`WritePipeline.extract` (`src/pipeline/index.ts:61-80`) is the only place that
references them, and only in a comment explaining they have no effect yet. No chat-
completion client exists in the codebase; `OpenAIEmbeddingProvider`
(`src/embedding/index.ts:37-`) is a raw-`fetch` client against the embeddings
endpoint, gated on `process.env[config.embedding.api_key_env]` being set (throws at
construction otherwise, lines 53-57) and wrapped in an optional `CircuitBreaker`
(constructor param, line 47; used at `src/index.ts:63-68`).

`fullTextSearch` (`src/storage/sqlite.ts:726-`) is still the legacy LIKE-based matcher
(`upgrade-fulltext-to-fts5` has landed only its capability probe and fallback test, per
its `tasks.md`) — it ANDs a `LIKE` condition per query term, so a stopword-heavy query
like "how do we deploy" requires literally "how", "do", "we", and "deploy" to all
appear in a memory's content/summary/tags. This is a real recall gap but a different
mechanism (conjunctive term matching, not embedding distance) with a different fix
(BM25/OR semantics), already tracked separately.

## Goals / Non-Goals

Goals:
- Widen the semantic candidate pool for vague/conversational queries by searching more
  than one representation of the query, without changing what a `search()` caller gets
  back structurally (same `SearchResult[]` shape, same `limit` bound on count).
- Ship a phase 1 with no new external dependency, no new config the operator must set
  to benefit, and bounded added cost (one extra batched embed + one extra Qdrant
  query, both parallelizable).
- Gate the model-backed phase 2 behind an explicit `enabled` flag *and* a resolvable
  API key, defaulting off, with a hard timeout and silent degrade to phase 1 on any
  failure.
- Keep `min_score` and composite-ranking semantics exactly as calibrated today — both
  still read `semantic_score`/`score` fields populated the same way, just from more
  candidates.

Non-Goals:
- No change to fulltext-only mode or hybrid's fulltext leg (see Impact — tracked under
  `upgrade-fulltext-to-fts5`).
- No general-purpose LLM/chat abstraction. Phase 2 adds one small, purpose-built
  provider for variant generation, not a reusable chat client for other features
  (extraction's own future LLM use, `write-decision-pipeline`, is a separate consumer
  to design when it lands).
- No caching of variant strings or their embeddings across calls — a future
  optimization if latency/cost from repeated identical queries becomes an issue.
- No change to `RecallFilter` (type/tags push-down): the same filter applies to every
  variant's store query unchanged.
- No non-English stopword handling; the phase-1 list is English-only.

## Decisions

- **Merge key and score fusion**: candidates from every variant's Qdrant search are
  merged by memory id; where an id appears in more than one variant's result set, the
  **max** score is kept (not sum/average). Rationale: sum would inflate a memory
  matched by two variants disproportionately relative to one matched by only its best
  variant, and would push composite/min_score comparisons out of the calibrated range;
  max keeps the field's meaning ("this memory's best cosine similarity to any
  representation of the query I searched") stable and directly comparable to the
  single-query score it replaces.
- **Truncate after merge, before scoring continues**: `semanticSearch` and
  `hybridSearch`'s semantic-leg merge step sorts the merged candidates by score
  descending and slices to `limit` before handing off to the existing RRF/composite
  pipeline — mirroring the `scored.slice(0, limit)` `hybridSearch` already does
  (`src/search/index.ts:275`). This keeps `search()`'s per-call result-count contract
  identical to today; only *membership* within that count can change.
- **Per-variant Qdrant `limit`**: each variant's store query requests the caller's
  `limit` (same as an unexpanded call would), not a fraction of it. Widening the net
  is the point; the merge-then-slice step above is what re-establishes the bound.
- **Batching**: variant strings are embedded in a single `embedBatch` call so phase 1's
  added latency is one extra Qdrant round trip, not an extra embedding round trip too.
- **Stopword-stripped variant guard rails** (`src/search/query-expansion.ts`, new):
  skip the variant when stripping stopwords leaves it identical to the original
  (all-content-word queries), or empty/whitespace-only (all-stopword queries, e.g. "is
  it"). The stopword list is a small, fixed, deterministic English set — no
  configurability beyond `keyword_stripped: boolean` to disable the whole variant.
- **Variant dedup**: variant strings are compared case-insensitively before embedding;
  an LLM paraphrase identical to the original or the keyword variant is dropped rather
  than embedded/searched again.
- **`max_variants` cap**: bounds the total variant count (original + keyword + LLM),
  independent of `llm_paraphrase.variant_count`; extra LLM variants beyond the cap are
  dropped, not queued for a later call. Keeps worst-case cost predictable regardless of
  how phase 1 and phase 2 config combine.
- **Phase 2 credential resolution reuses the extraction hook**: `LLMQueryExpansionProvider`
  reads `process.env[config.pipeline.extraction_model_env]`, falling back to
  `process.env.OPENAI_API_KEY` when unset — implementing the fallback `README.md:519`
  already documents ("Falls back to `OPENAI_API_KEY`") but that no code currently
  does. If neither resolves, phase 2 is treated as unconfigured: log once at startup
  (mirroring `warnIfEmbeddingDegraded`-style startup visibility, `src/index.ts:69`) and
  skip LLM expansion on every call without per-call error noise.
- **Phase 2 client shape**: a raw-`fetch` client against the OpenAI-compatible Chat
  Completions endpoint using `pipeline.extraction_model`, modeled directly on
  `OpenAIEmbeddingProvider`'s existing fetch/parse/error pattern
  (`src/embedding/index.ts:60-`) rather than adding an SDK dependency. Wrapped in its
  own `CircuitBreaker` (new `key: 'extraction'`, constructed alongside
  `embeddingBreaker`/`qdrantBreaker` at `src/index.ts:63-65`) so a failing extraction
  endpoint can't be hammered every recall call.
- **Timeout**: `llm_paraphrase.timeout_ms` (default 3000) aborts the fetch via
  `AbortController`; a timeout is treated the same as any other failure — degrade to
  phase 1, increment a metric, log at `warn`.
- **`mode: 'paraphrase' | 'hyde'`, default `'paraphrase'`**: paraphrase generation
  ("reword this query 2 different ways") is the default because it stays anchored to
  what the user actually asked; HyDE (generate a plausible answer, embed that) is
  offered as an explicit opt-in for callers who find it improves recall for their
  content, with the hallucination trade-off documented rather than hidden.
- **Where NOT applied**: `fulltextSearch` (standalone mode) and `hybridSearch`'s
  fulltext leg keep searching the single original `query` string. Expanding the
  fulltext leg too would double-count variant effort across two matchers with
  different failure modes and overlap the in-flight `upgrade-fulltext-to-fts5`
  rewrite of the same code path; kept as a clean follow-up once that lands.

## Risks / Trade-offs

- **Default-on phase 1 changes cost/latency for every semantic/hybrid call**, not just
  vague ones — mitigated by batching the embed call, parallelizing the extra Qdrant
  query, and a top-level `search.query_expansion.enabled` kill switch for operators who
  want the pre-change cost profile.
- **Phase 2 is the first live-path LLM chat dependency** in a codebase that has none
  today; a slow or misbehaving extraction endpoint could add real latency to recall if
  the timeout/breaker/degrade path has a bug. Mitigated by defaulting off, a short
  default timeout, and the same degrade-to-fulltext-style pattern `hybridSearch`
  already uses for embedding failures (`src/search/index.ts:226-238`,
  `search_embedding_degraded`).
- **English-only stopword list**: non-English or highly technical/jargon-only queries
  may get a keyword-stripped variant that isn't meaningfully different from the
  original, or (rarely) an over-stripped variant that loses intent. Bounded impact: the
  original query is always included as a variant, so this can only add candidates, not
  remove the baseline ones.
- **HyDE hallucination**: a generated hypothetical answer can introduce specifics (tool
  names, numbers) absent from the user's actual query, pulling the embedding toward
  content that merely sounds plausible. Mitigated by defaulting `mode` to
  `'paraphrase'` and documenting the trade-off in README rather than defaulting to
  `'hyde'`.
- **Score-field semantics shift slightly**: `semantic_score` on a `SearchResult` now
  means "best score across searched variants" rather than "score against the literal
  query," which is a change in what the field represents even though its numeric range
  and calibration against `min_score`/composite ranking are unchanged. Documented in
  README rather than silently redefined.
