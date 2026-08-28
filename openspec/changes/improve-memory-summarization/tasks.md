## 1. Config schema

- [ ] 1.1 Add to the `pipeline` object in the Zod config schema
  (`src/config/index.ts:211-216`): `summarization_enabled` (`z.boolean().default
  (false)`), `summarization_model` (`z.string().default('gpt-4o-mini')`),
  `summarization_model_env` (`z.string().default('BHGBRAIN_EXTRACTION_API_KEY')`),
  `summarization_timeout_ms` (`z.number().positive().default(3000)`).
- [ ] 1.2 Leave `auto_summarize` (`src/config/index.ts:217`) as-is — it becomes
  load-bearing via task 3.x, no schema change needed there.
- [ ] 1.3 Add `pipeline.summarization_model_env`'s referenced var to
  `.env.example`'s secrets section, noting it defaults to the same var as
  `extraction_model_env` (mirror the existing `BHGBRAIN_EXTRACTION_API_KEY` comment
  block, `.env.example:26-28`).

## 2. Extractive summarizer (default tier, zero config)

- [ ] 2.1 Create `src/domain/summarize.ts`. Implement `extractiveSummary(content:
  string, maxLen = 120): string`: split on `/[.!?\n]+/`, tokenize to lowercase
  word tokens per sentence, compute document-wide term frequency (small hardcoded
  stopword list, no new dependency), score each sentence
  `sum(tf(token)) / sqrt(tokenCount)`, pick the highest score (ties → earliest
  sentence), truncate to `maxLen` with the same `substring(0, maxLen - 3) + '...'`
  convention as `generateSummary` (`src/domain/normalize.ts:15-19`). Empty/whitespace
  content returns `''`; single-sentence content returns that sentence unchanged
  (matches current single-line behavior).
- [ ] 2.2 Add `summarizeContent(content: string, config: BrainConfig, provider?:
  SummarizationProvider, logger?): Promise<string>` to `src/domain/summarize.ts`:
  `config.auto_summarize === false` → `generateSummary(content)`; else if
  `config.pipeline.summarization_enabled` and `provider` resolves → try
  `provider.summarize(content, 120)`, catch-and-fall-back-to `extractiveSummary` on
  any rejection (log a warn via `logger`, don't throw); else → `extractiveSummary`.
- [ ] 2.3 Unit tests in `src/domain/summarize.test.ts`: extractive picks the
  higher-signal sentence over a low-signal first line; single-sentence/single-line
  content is unchanged from `generateSummary`'s output; empty content; `maxLen`
  truncation still applies to the selected sentence; `auto_summarize: false` routes
  to literal truncation even with a healthy LLM provider configured.
- [ ] 2.4 Update `src/domain/normalize.test.ts:46-48` (`generateSummary('first\n
  second')` expecting `'first'`) — `generateSummary` itself is unchanged (still
  first-line truncation, used only for the `auto_summarize: false` path), so this
  assertion stays correct; add a companion case in `summarize.test.ts` showing
  `extractiveSummary('first\nsecond')` considers both lines, to make the behavior
  split between the two functions explicit.

## 3. LLM-summary tier (optional, config-gated)

- [ ] 3.1 Define `SummarizationProvider` interface (`summarize(content: string,
  maxLen: number): Promise<string>`) in `src/summarization/index.ts`, plus
  `OpenAISummarizationProvider` (POST `https://api.openai.com/v1/chat/completions`
  with `config.pipeline.summarization_model`, a system prompt requesting one
  plain-text sentence under `maxLen` chars, response hard-truncated with the
  `generateSummary` `...` convention regardless of what the model returns) and
  `DegradedSummarizationProvider` (constructed when
  `process.env[config.pipeline.summarization_model_env]` is unset; `summarize()`
  rejects, mirroring `DegradedEmbeddingProvider` in `src/embedding/index.ts:127-152`).
  Both wrap the fetch call in `config.pipeline.summarization_timeout_ms` via
  `AbortController`.
- [ ] 3.2 Add `createSummarizationProvider(config, options?: { breaker?, metrics? }):
  SummarizationProvider | undefined` — returns `undefined` when
  `pipeline.summarization_enabled` is `false` (no provider constructed at all, so the
  default path never touches this module), mirroring `createEmbeddingProvider`
  (`src/embedding/index.ts:180-206`).
- [ ] 3.3 Wire into `src/index.ts`: construct the provider after `embedding`
  (~line 68-70), a new `CircuitBreaker` keyed `'summarization'` using the same
  `breakerOptions` (~line 58-65) only when the provider is defined, pass the
  provider into both `new StorageManager(...)` (line 70) and `new WritePipeline
  (...)` (line 103) as a new optional constructor argument. Emit a startup warn
  (mirroring `warnIfEmbeddingDegraded`, `src/embedding/index.ts:166-178`) when
  `summarization_enabled` is true but the resolved provider is degraded
  (missing credentials).
- [ ] 3.4 Tests for `OpenAISummarizationProvider`/`DegradedSummarizationProvider` in
  `src/summarization/index.test.ts`: success path truncates an over-length model
  response; non-2xx response falls back (caller's responsibility per 2.2, but assert
  the provider surfaces a rejection rather than swallowing internally); timeout
  aborts and rejects within `summarization_timeout_ms`; degraded provider always
  rejects without a network call.

## 4. Write-path integration

- [ ] 4.1 `src/pipeline/index.ts`: thread an optional `summarizer?:
  SummarizationProvider` through the `WritePipeline` constructor (alongside
  `embedding`, line 20-27). Replace `const summary = generateSummary(candidate
  .content);` at line 145 with a call to `summarizeContent(candidate.content, this
  .config, this.summarizer, this.logger)`, started concurrently with the
  `this.embedding.embed(candidate.content)` call (~line 121) via `Promise.allSettled`
  — embed's rejection is re-thrown/handled exactly as today (existing
  `fallback_to_threshold_dedup` branch), summarization's rejection is impossible to
  observe here since `summarizeContent` itself never rejects (task 2.2 catches
  internally); await both before the branch that needs `summary` (still before line
  145's insertion point).
- [ ] 4.2 `src/pipeline/index.ts:359` (`deterministicFallback`): replace
  `generateSummary(candidate.content)` with `await summarizeContent(candidate
  .content, this.config, this.summarizer, this.logger)`. No concurrency change
  needed here — there is no embed call in this degraded path to overlap with.
- [ ] 4.3 `src/storage/index.ts:264` (`revertMemory`): add a new optional
  `summarizer?: SummarizationProvider` parameter to `StorageManager`'s constructor
  (`constructor(...)` at line 60-69, after the existing optional `config?:
  BrainConfig` param) and replace `generateSummary(target.content)` with `await
  summarizeContent(target.content, this.config, this.summarizer, this.logger)`. Note
  `config` is itself optional there already (comment at lines 65-67 explains why);
  `summarizeContent` must handle an undefined `config` the same way that comment
  describes — fall back to schema defaults (`auto_summarize: true`, extractive tier).
- [ ] 4.4 Update existing call-site instantiations of `WritePipeline`/
  `StorageManager` across the test suite only where a test asserts on `.summary`
  content for multi-line input — leave the (majority) unaffected fixtures alone
  since the new constructor argument is optional.

## 5. Tests — integration

- [ ] 5.1 `src/pipeline/index.test.ts`: ADD/UPDATE/DELETE outcomes carry an
  extractive (not first-line) summary for multi-sentence content when no summarizer
  is configured; `auto_summarize: false` in the test config restores literal
  first-line truncation.
- [ ] 5.2 `src/pipeline/index.test.ts`: with a mocked `SummarizationProvider` that
  rejects, the write still succeeds and the persisted summary is the extractive
  fallback, not an error.
- [ ] 5.3 `src/pipeline/index.test.ts`: with a mocked `SummarizationProvider` that
  resolves, the persisted summary is the (truncated) provider output.
- [ ] 5.4 `src/storage/index.test.ts` (`revertMemory` describe block, ~line 261+):
  reverting to a multi-sentence revision produces an extractive summary of that
  revision's content, not its first line.
- [ ] 5.5 Regression: `fullTextSearch` tests (`src/storage/sqlite.test.ts`) are
  unaffected by this change (scoring formula untouched) — no new assertions needed
  there beyond confirming existing tests still pass with extractively-generated
  summaries in fixtures that build them via `generateSummary`/`extractiveSummary`.

## 6. Validation

- [ ] 6.1 `npm run lint` (tsc --noEmit + eslint src) passes — no `any` casts,
  especially around the `AbortController`/fetch typing in
  `src/summarization/index.ts`.
- [ ] 6.2 `npm test` passes, including the new `src/domain/summarize.test.ts` and
  `src/summarization/index.test.ts` suites.
- [ ] 6.3 Update `README.md`'s pipeline config block (`README.md:491-504`): document
  `summarization_enabled`/`summarization_model`/`summarization_model_env`/
  `summarization_timeout_ms`, and correct the `auto_summarize` line
  (`README.md:503-504`) to describe the real tiered behavior instead of the
  previously-dead flag. Mirror the same edits into `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md`.
- [ ] 6.4 Bump `package.json` `version` (currently `1.11.0`) — user-visible behavior
  change (summary content, new config fields).
