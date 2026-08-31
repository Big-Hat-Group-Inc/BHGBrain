## Why

Recall and search embed exactly one string per query. `semanticSearch`
(`src/search/index.ts:137-168`) makes a single `this.embedding.embed(query)` call
(`src/search/index.ts:146`), and hybrid mode's semantic leg does the same
(`src/search/index.ts:214`). `handleRecall` (`src/tools/index.ts:156-205`) always
invokes `search()` in `'semantic'` mode, so every recall call sits behind this
single-embed path.

A conversational query like "how do we deploy" embeds far from a memory phrased
"deployment runs via `docker-compose up -d`" — both are about the same thing, but
cosine similarity between the two embeddings can land below `min_score` (0.6 default,
`src/domain/schemas.ts:45`), so a memory that plainly answers the query never
surfaces. Nothing about ranking (`add-composite-recall-ranking`) or filter push-down
(`push-down-recall-filters`) helps here: both operate on the candidate set a single
embed call already produced. The fix is upstream — search more than one representation
of the query and union the candidates before those stages run.

The repository already reserves an LLM hook for exactly this class of feature:
`pipeline.extraction_model` / `pipeline.extraction_model_env`
(`src/config/index.ts:213-214`), documented in `README.md:492-501` and
`.env.example:26-28`. Nothing reads it today — `WritePipeline.extract`
(`src/pipeline/index.ts:61-80`) is a deterministic single-candidate stub with a
`TODO(bootstrap-memory-core)` noting the config knob has no effect yet. There is no
chat-completion client anywhere in `src/`; the only outbound LLM call in the codebase
is `OpenAIEmbeddingProvider`'s embeddings-endpoint fetch (`src/embedding/index.ts`).
A model-backed paraphrase/HyDE variant generator would be this hook's first real
consumer — a bigger, network-dependent addition — while a keyword-stripped variant is
a same-process, no-new-dependency win available today.

## What Changes

- Add a `search.query_expansion` config block (Zod schema + defaults) with two
  independently gated stages:
  - **Phase 1 (default on, no model)**: alongside the original query, generate a
    keyword-stripped variant (English stopwords removed) when it differs from the
    original and is non-empty. Embed both via the existing `embedBatch` (one HTTP
    round trip, not two) and search both vectors in Qdrant.
  - **Phase 2 (default off, model-gated)**: when `search.query_expansion.llm_paraphrase.enabled`
    is true *and* `pipeline.extraction_model_env` resolves to a set environment
    variable (falling back to `OPENAI_API_KEY`, matching the behavior `README.md:519`
    already documents but that no code implements), call a new minimal chat-completion
    client to generate 1-3 paraphrases or a hypothetical-answer (HyDE) passage, and
    embed/search each. Any failure (missing key, non-2xx, timeout) degrades silently
    to phase-1-only variants — recall must never fail because paraphrase generation
    failed.
- Apply expansion in `semanticSearch` and the semantic leg of `hybridSearch` only.
  Candidates from all variants are merged by memory id, keeping the max score per id
  (not summed — a memory matched by two variants should not be inflated relative to
  one matched by only its strongest variant), then the merged set is truncated back to
  the caller's `limit` before scoring/ranking/expiry-filtering continue unchanged in
  `buildSearchResults`. `min_score` and composite-ranking semantics are unaffected —
  both operate on the same score fields as before, now populated from a wider
  candidate pool.
- The fulltext-only search mode and the fulltext leg of hybrid search are **not**
  expanded by this change (see Capabilities).
- Document the new config block and the (now-implemented) `extraction_model_env`
  fallback in `README.md` + the four translations; bump `package.json` version.

## Capabilities

### New Capabilities
- `multi-query-expansion`: Semantic recall/search embeds and searches more than one
  representation of a query — a deterministic keyword-stripped variant always, and
  optional LLM-generated paraphrase/HyDE variants when explicitly enabled and an
  extraction model key is configured — unioning candidates by id before scoring.

### Modified Capabilities

## Impact

- Affected code: `src/search/index.ts` (`semanticSearch`, `hybridSearch`),
  `src/search/query-expansion.ts` (new — stopword list, variant generation, LLM
  provider), `src/config/index.ts` (new `search.query_expansion` schema),
  `src/index.ts` (wiring the optional LLM expansion provider + breaker), co-located
  tests.
- Behavior: recall/search candidate pool widens for vague/conversational queries
  (higher recall), at the cost of one extra batched embed call + one extra Qdrant
  query per semantic/hybrid search in the default configuration (phase 1). Phase 2 is
  opt-in and adds LLM latency/cost only when explicitly enabled with a resolvable key.
  Result *count* per call is unchanged (`limit` still bounds it); result *membership*
  can grow to include memories only the expanded variant(s) found.
- Explicitly out of scope: fulltext-only mode and hybrid's fulltext leg keep searching
  the original query only — their separate stopword-conjunction weakness
  (`src/storage/sqlite.ts` `fullTextSearch`'s AND-of-terms `LIKE` matching) is tracked
  under `upgrade-fulltext-to-fts5`, not here, to avoid two in-flight changes touching
  the same matcher.
- Docs: README ×5, `.env.example` (extraction key doc, unchanged content but now
  accurate), `AGENTS.md` if the config-vs-env section needs a fallback note, version
  bump.
- Depends on: `pipeline.extraction_model` / `extraction_model_env`
  (`src/config/index.ts:213-214`) as the phase-2 credential source; does not require
  `upgrade-fulltext-to-fts5` or any other in-flight proposal to land first.
