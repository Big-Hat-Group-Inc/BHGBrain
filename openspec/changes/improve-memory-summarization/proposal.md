## Why

`generateSummary` (`src/domain/normalize.ts:15-19`) is the first line of content,
truncated to 120 chars:

```ts
export function generateSummary(content: string, maxLen = 120): string {
  const firstLine = content.split('\n')[0] ?? '';
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.substring(0, maxLen - 3) + '...';
}
```

For single-line content this is fine. For multi-line content it is often useless: a
memory whose first line is "Meeting notes:" or "Context:" produces a summary with no
signal, while the actual substance sits on line two onward and is silently discarded
(`content.split('\n')[0]`, not the whole text).

That weak field is not cosmetic — it is load-bearing in three places:

- **Fulltext ranking**: `fullTextSearch` (`src/storage/sqlite.ts:770-796`) scores
  candidate rows by summed term-frequency across content, summary, and tags, weighting
  summary and tags matches 2× over content (`src/storage/sqlite.ts:786-790`:
  `score += count(content) + count(summary) * 2 + count(tags) * 2`). A signal-free
  summary means the field carrying double weight in every fulltext (and hence hybrid
  RRF) ranking contributes noise instead of relevance. Note: `upgrade-fulltext-to-fts5`
  attempted to move this to FTS5 `bm25()` scoring but its tasks.md records the premise
  failed — the pinned `sql.js` build has no `fts5` module — so this LIKE/TF scorer with
  the 2× summary/tag weight is still the real, current implementation.
- **`memory://list` and `memory://{id}` browsing**: every list/get response surfaces
  `.summary` (`src/tools/index.ts:307`, `src/cli/index.ts:67`) as the human-scannable
  label for a memory.
- **Session inject fallback**: `ResourceHandler` (`src/resources/index.ts:284-290`)
  prints `mem.content` when it fits the remaining budget, else falls back to
  `mem.summary` — exactly the degraded case where a real summary matters most, because
  it is standing in for content that didn't fit.

The config schema already carries a flag for this: `auto_summarize: z.boolean()
.default(true)` (`src/config/index.ts:217`), documented in `README.md:503-504` as
"Auto-summarize memory content on ingestion" — but nothing in `src/` reads it. It is
dead config (confirmed: the only other references are test fixtures spreading a full
config object). This proposal is also the fix for that drift: `auto_summarize` becomes
the real on/off switch for summarization quality.

## What Changes

- Add a dependency-free **extractive** summarizer: score each sentence in the content
  by the sum of its tokens' term frequency in the document (a small hardcoded English
  stopword list excluded), normalized by sentence length, and return the
  highest-scoring sentence, truncated to `maxLen` with the existing `...` convention.
  This becomes the default summarization strategy whenever `auto_summarize` is `true`
  (the existing default) — no config, no network call, no new dependency.
- When `auto_summarize` is `false`, keep today's literal first-line-truncation
  (`generateSummary`) — the cheapest possible path, preserved as an explicit opt-out
  rather than removed.
- Add an optional **LLM-summary** tier, gated behind new `pipeline.summarization_*`
  config (mirroring the existing, currently-unused `pipeline.extraction_model` /
  `extraction_model_env` pattern): when `pipeline.summarization_enabled` is `true` and
  credentials resolve, a cheap chat-completion call produces the summary instead of the
  extractive one. Any failure (missing key, non-2xx, timeout, network error) falls back
  to the extractive tier for that write — summarization never blocks or fails a
  `remember`/`revert` call.
- Run the LLM summarization request concurrently with the embedding request in the
  write pipeline (`src/pipeline/index.ts` around the `embed()` call) rather than
  serially after it, so enabling the LLM tier does not double per-write latency.
- Wire the same summarizer into `revertMemory` (`src/storage/index.ts:262-268`), which
  currently calls `generateSummary` directly on the reverted revision's content.

## Capabilities

### New Capabilities
- `memory-summarization`: Memory summaries are produced by a tiered summarizer
  (extractive by default, optional LLM-backed, literal-truncation opt-out) instead of a
  fixed first-line truncation, improving the signal carried by the field that fulltext
  search double-weights and that list/browse/inject-fallback surfaces display.

### Modified Capabilities

## Impact

- Affected code: `src/domain/normalize.ts` (or a new `src/domain/summarize.ts` housing
  the extractive/LLM orchestration, keeping `generateSummary` as the literal-truncation
  primitive), `src/pipeline/index.ts` (both `summary = generateSummary(...)` call
  sites, lines 145 and 359), `src/storage/index.ts:264` (`revertMemory`),
  `src/config/index.ts` (new `pipeline.summarization_*` fields; `auto_summarize`
  finally read), `src/index.ts` (provider/breaker wiring), possibly a new
  `src/summarization/` provider module mirroring `src/embedding/index.ts`'s
  `OpenAIEmbeddingProvider` / `DegradedEmbeddingProvider` / breaker-key pattern.
- Behavior: summary text changes for multi-line/multi-sentence content (this is the
  point); single-line content is unaffected since the extractive scorer degenerates to
  "the one sentence" in that case. Fulltext ranking quality improves as a downstream
  effect of a more representative summary field, with no scoring-formula change.
- Config: new `pipeline.summarization_enabled` (default `false`),
  `pipeline.summarization_model` (default `gpt-4o-mini`),
  `pipeline.summarization_model_env` (default reuses `BHGBRAIN_EXTRACTION_API_KEY`),
  `pipeline.summarization_timeout_ms`. `auto_summarize` behavior finally matches its
  README description.
- Docs: `README.md` + 4 translations (pipeline config block, `auto_summarize`
  description), `.env.example` (note the shared-key default), `package.json` version
  bump.
- Depends on: nothing. Compounds with `add-composite-recall-ranking` and
  `upgrade-fulltext-to-fts5` (both consume/rank the same `summary` field) but does not
  require either to be complete.
