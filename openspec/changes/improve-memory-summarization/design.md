## Context

`generateSummary(content, maxLen = 120)` (`src/domain/normalize.ts:15-19`) is called
from exactly three sites, all inside already-`async` functions, which is what makes an
async tiered summarizer a drop-in replacement rather than a signature-breaking change:

- `src/pipeline/index.ts:145` — the main write path (`decide`), after similarity search,
  before the ADD/UPDATE/DELETE branches. `summary` is computed once and reused across
  all three outcomes (lines 173, 217, 259).
- `src/pipeline/index.ts:359` — `deterministicFallback`, the embeddingless degraded
  write path (checksum + FTS-based similarity instead of vector search).
- `src/storage/index.ts:264` — `revertMemory`, which re-embeds a prior revision's
  content and needs a fresh summary for it.

`auto_summarize` (`src/config/index.ts:217`) is declared in the Zod schema, defaulted
`true`, documented in `README.md:503-504`, and referenced nowhere else in `src/`
outside of test fixtures that spread a complete config object. It is inert. There is no
precedent in this codebase for an LLM call from the write path: `pipeline.
extraction_model` / `extraction_model_env` (`src/config/index.ts:213-214`) are
declared but explicitly noted as unused in `src/pipeline/index.ts:65-71` ("v1
extraction is deterministic... the config knob is reserved for a future model-backed
extraction stage"). The only existing pattern for an external-API write-path call is
the embedding provider (`src/embedding/index.ts`): a `Provider` interface, a
`Degraded*Provider` that fails closed when credentials are missing at construction
time, a named `CircuitBreaker` key, and a `warnIfEmbeddingDegraded` startup log. The
LLM-summary tier reuses that shape rather than inventing a new one.

`fullTextSearch` (`src/storage/sqlite.ts:726-797`) is, despite `upgrade-fulltext-to-
fts5`'s intent, still the original LIKE-based term-frequency scorer — that proposal's
`tasks.md` records the FTS5 premise failed against the pinned `sql.js` build (no
`fts5` module) and left the rewrite unimplemented. So the "summary/tags weighted 2×"
scoring this proposal's Why section leans on (`src/storage/sqlite.ts:786-790`) is
current code, not a stale claim from the brainstorm doc.

## Goals / Non-Goals

Goals:
- Make the default (`auto_summarize: true`, no other config) summary meaningfully
  better than first-line truncation, with zero new runtime dependency and zero added
  write-path latency in the common case.
- Give operators who want higher-quality abstractive summaries an opt-in path that
  degrades to the extractive tier on any failure — a `remember` or `revert` call must
  never fail or block because summarization failed.
- Make `auto_summarize` do what its README description already claims.
- Keep the `summary` field's existing invariants intact: string, `<= 120` chars
  (`maxLen`), single line (no embedded `\n` — consumers like `cli/index.ts:67` print it
  on one line).

Non-Goals:
- No change to the fulltext scoring formula itself (weights, candidate cap) — this
  proposal changes what feeds the summary field, not how it's scored. A follow-up
  could revisit the 2× weight once FTS5/BM25 lands for real.
- No Azure Foundry chat-completion provider. `pipeline.extraction_model` already
  assumes an OpenAI-shaped model name (`gpt-4o-mini`); the LLM-summary tier follows
  that precedent (OpenAI Chat Completions only) rather than doubling the provider
  matrix embeddings has. Azure support is a follow-up if there's demand.
- No multi-sentence or bullet-style summaries — the field is capped at 120 chars by
  design (list/CLI rendering assumes one short line); the extractive tier picks one
  sentence, the LLM tier is prompted for one.
- No retroactive re-summarization of existing memories — this changes summary
  generation for new writes and reverts only, matching how `add-composite-recall-
  ranking` and `stamp-embedding-provenance` scoped their write-path-only changes.

## Decisions

- **Extractive algorithm — TF-scored sentence, length-normalized.** Split content into
  sentences on `/[.!?\n]+/` (dependency-free; good enough for a non-authoritative
  display field). Tokenize each sentence to lowercase words, excluding a small
  hardcoded English stopword list (~40 words: "the", "a", "is", "and", ... — no new
  package). Compute document-wide term frequency once, then score each sentence as
  `sum(tf(token) for token in sentence) / sqrt(token_count)`. Raw-sum (literally
  "highest-TF sentence") biases toward the longest sentence regardless of content;
  `sqrt`-length normalization (a standard Luhn-style adjustment) picks the sentence
  most representative of the document's vocabulary without just picking the longest
  one. Ties break on earliest sentence position (deterministic, and mirrors today's
  "first line" bias for content where every sentence scores equally, e.g. single-
  sentence content). Single-sentence or single-line content degenerates to exactly
  today's behavior (that sentence, truncated) — this is why the existing
  `generateSummary('Short line')` and long-single-line tests keep passing unchanged;
  only the multi-sentence test (`normalize.test.ts:46-48`,
  `generateSummary('first\nsecond')` → `'first'`) changes, deliberately, since
  discarding the second line is exactly the bug this proposal fixes.
- **Where the tiers live.** `generateSummary` in `src/domain/normalize.ts` stays as-is
  — the literal truncation primitive, used directly when `auto_summarize` is `false`.
  A new `src/domain/summarize.ts` adds `extractiveSummary(content, maxLen)` (sync,
  the TF algorithm above) and an async `summarizeContent(content, config, provider?,
  logger?)` orchestrator that picks the tier: `auto_summarize: false` →
  `generateSummary`; LLM enabled and provider healthy → LLM with extractive fallback
  on any throw; else → `extractiveSummary`. Keeping `generateSummary` untouched avoids
  a breaking signature change for its one still-valid use (the opt-out path) and keeps
  the diff to the three call sites plus the new module.
- **LLM provider shape mirrors `src/embedding/index.ts`.** A `SummarizationProvider`
  interface (`summarize(content, maxLen): Promise<string>`), an
  `OpenAISummarizationProvider` hitting `POST /v1/chat/completions` with a short
  system prompt ("respond with one plain-text sentence, no preface, under N
  characters") and the response hard-truncated afterward with the same `...`
  convention `generateSummary` uses — the model is a hint, not a guarantee, so the
  120-char invariant is enforced in code regardless of what comes back. A
  `DegradedSummarizationProvider` (credentials missing at construction) mirrors
  `DegradedEmbeddingProvider`: constructed, not thrown, so startup never fails on a
  missing optional key; `summarizeContent` treats "degraded provider" identically to
  "provider threw" — fall back to extractive.
- **Config**: `pipeline.summarization_enabled` (default `false` — this is a new
  external call with cost/latency implications, so unlike `auto_summarize` it does not
  default on), `pipeline.summarization_model` (default `'gpt-4o-mini'`, same default
  as `extraction_model`), `pipeline.summarization_model_env` (default
  `'BHGBRAIN_EXTRACTION_API_KEY'` — reuses the extraction pipeline's key by default
  since both are cheap-model write-path calls against the same OpenAI account; an
  operator who wants a distinct key can point it elsewhere), `pipeline.
  summarization_timeout_ms` (default `3000`). All under the existing `pipeline` config
  object (`src/config/index.ts:211-216`), not a new top-level block.
- **Concurrency with the embed call.** In `src/pipeline/index.ts`'s `decide`, the
  embedding request (`this.embedding.embed(candidate.content)`, current line ~121) and
  the summarization request depend on the same input (`candidate.content`) and nothing
  else — neither needs the other's result. Kick both off together (`Promise.all` /
  `allSettled`) instead of the current sequential shape (embed, then similarity
  search, then `generateSummary` at line 145) so enabling the LLM tier adds at most
  `max(embed_latency, summarize_latency)` to a write, not their sum. Embedding failure
  must still hard-fail (existing `fallback_to_threshold_dedup` semantics) while
  summarization failure must never hard-fail — so this is `Promise.allSettled`, not
  `Promise.all`, with the embed leg's rejection re-thrown explicitly and the summary
  leg's rejection swallowed into the extractive fallback.
- **Circuit breaker.** A new named breaker (`'summarization'` key, same
  `resilience.circuit_breaker` thresholds already used for embedding/Qdrant) wraps the
  LLM call, constructed in `src/index.ts` alongside `embeddingBreaker`/`qdrantBreaker`
  only when `pipeline.summarization_enabled` is true — an open breaker is just another
  path into the extractive fallback, not a new failure mode to handle.
- **`revertMemory` gets the same tiering**, not a special case: `src/storage/
  index.ts:264` swaps `generateSummary(target.content)` for `summarizeContent(...)`,
  passed the same provider `StorageManager` already threads through for re-embedding.

## Risks / Trade-offs

- **Extractive quality is heuristic, not semantic.** TF-based sentence scoring can
  still pick a mediocre sentence (e.g. one dense with repeated boilerplate words). It
  is strictly better than "whatever happens to be first," not a solved problem;
  operators who need real quality opt into the LLM tier.
- **LLM tier cost/latency at scale.** Every `remember`/`revert` call becomes a second
  external API call when enabled. Mitigated by: default `false`, a tight timeout
  (3s default), and a circuit breaker so a degraded OpenAI endpoint doesn't compound
  into every write stalling for the full timeout.
- **Shared API key by default.** Defaulting `summarization_model_env` to the same env
  var as `extraction_model_env` means a compromised or rate-limited key affects two
  pipeline features at once. Documented explicitly in README/`.env.example` so
  operators know they can split it.
- **Sentence-splitting on punctuation is naive** (no abbreviation handling, no
  quote-aware splitting). Acceptable because the output feeds a non-authoritative
  display/ranking-input field, not anything parsed back structurally; a
  mis-split "sentence" just becomes a slightly odd but still truncation-safe summary
  candidate.
- **Behavior change for existing multi-line-content tests/consumers.** Any test or
  snapshot asserting the exact current first-line-only summary for multi-line content
  will need deliberate updates (called out in tasks.md), not silent adaptation —
  consistent with how `upgrade-fulltext-to-fts5`'s design.md treats result-set drift
  from a scoring change.
