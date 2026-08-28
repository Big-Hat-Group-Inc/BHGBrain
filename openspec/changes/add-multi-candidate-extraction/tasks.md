## 1. Config schema

- [ ] 1.1 In `src/config/index.ts`'s `pipeline` object (currently
  `src/config/index.ts:211-216`): flip `extraction_enabled`'s default from `true` to
  `false`. Add `extraction_min_chars: z.number().int().nonnegative().default(120)`,
  `extraction_max_candidates: z.number().int().positive().default(6)`,
  `extraction_timeout_ms: z.number().int().positive().default(4000)`. Leave
  `extraction_model`, `extraction_model_env`, `fallback_to_threshold_dedup` unchanged.
- [ ] 1.2 Add a `getExtractionBreakerKey()`-style constant (or inline `'extraction'`
  literal, matching the simplicity of `'qdrant'`'s key in `src/index.ts:65`) — no new
  function needed unless a second extraction-capable provider is added later.

## 2. Extraction provider

- [ ] 2.1 Create `src/pipeline/extraction.ts` mirroring `src/embedding/index.ts`'s
  shape: an `ExtractionProvider` interface with
  `extractCandidates(content: string): Promise<RawCandidate[] | null>` (`null` means
  "extraction not attempted, use deterministic single-candidate"), a `RawCandidate`
  type (`{ content: string; type?: MemoryType; importance?: number }`).
- [ ] 2.2 Implement `LlmExtractionProvider`: chat-completions call to
  `https://api.openai.com/v1/chat/completions` with `model:
  config.pipeline.extraction_model`, `response_format: {type:'json_object'}`, a system
  prompt instructing atomic self-contained fact splitting (single-fact input returns
  one candidate, ideally verbatim), bounded by `AbortController` at
  `extraction_timeout_ms`, executed through a `CircuitBreaker` (key `'extraction'`,
  same `resilience.circuit_breaker` options object already built in `src/index.ts:58-62`).
- [ ] 2.3 Define and apply a Zod response schema (`candidates: z.array(z.object({
  content: z.string().trim().min(1), type: MemoryTypeEnum.optional(), importance:
  z.number().min(0).max(1).optional() })).min(1)`); on parse/validation failure, return
  `null` rather than throwing, after logging `event: 'extraction_invalid_response'`.
- [ ] 2.4 Apply `extraction_max_candidates`: candidates beyond the cap are dropped (not
  merged); log `event: 'extraction_candidates_truncated'` and increment
  `extraction_candidates_truncated_total` when truncation occurs.
- [ ] 2.5 Implement `NoopExtractionProvider` (always returns `null`, no network call)
  and `createExtractionProvider(config, options)`: returns `NoopExtractionProvider` when
  `!config.pipeline.extraction_enabled`, or when neither
  `process.env[config.pipeline.extraction_model_env]` nor `process.env.OPENAI_API_KEY`
  resolves; otherwise returns `LlmExtractionProvider`.
- [ ] 2.6 Implement `warnIfExtractionDegraded(provider, config, logger)`, called once at
  startup (mirroring `warnIfEmbeddingDegraded` in `src/embedding/index.ts:166-178`),
  logging `event: 'extraction_degraded_startup'` only when `extraction_enabled` is true
  but no key resolved (distinguishing "deliberately off" from "misconfigured").

## 3. Pipeline integration

- [ ] 3.1 In `src/pipeline/index.ts`, add an optional `extraction?: ExtractionProvider`
  constructor parameter to `WritePipeline` (default to a `NoopExtractionProvider` when
  omitted, so existing call sites/tests that don't pass one keep today's behavior).
- [ ] 3.2 Change `extract()` (`src/pipeline/index.ts:61-80`) to `async`. When
  `normalized.length >= config.pipeline.extraction_min_chars`, call
  `this.extraction.extractCandidates(normalized)`; on a non-null, non-empty result, map
  each `RawCandidate` to a `MemoryCandidate` (falling back to `input.type`/
  `input.tags`/`input.importance` for fields the extraction result omits, per
  candidate). On `null`, a rejected promise, or content shorter than the gate, return
  today's single-candidate array unchanged. Wrap the extraction call in try/catch so an
  unexpected throw (not just a `null` return) never propagates out of `extract()`.
  Remove the stale TODO comment (`src/pipeline/index.ts:68-73`) once implemented.
- [ ] 3.3 Update `process()` (`src/pipeline/index.ts:29-59`) to `await this.extract(...)`
  and change the candidate loop to try/catch per candidate: collect successful
  `WriteResult`s; on a candidate throwing, log `event: 'candidate_write_failed'`
  (namespace, collection, candidate index, error message) and increment
  `extraction_candidate_failed_total`, then continue to the next candidate. After the
  loop, if zero candidates succeeded and at least one was attempted, rethrow the last
  captured error (preserving today's single-candidate throw behavior). Otherwise return
  the successful `WriteResult[]`.
- [ ] 3.4 Wire the extraction provider and breaker into both call sites: `src/index.ts`
  (alongside `embeddingBreaker`/`qdrantBreaker` construction, ~`src/index.ts:58-68`,
  and the `new WritePipeline(...)` call at `src/index.ts:103`) and `src/cli/index.ts:41`.
  Do **not** add the extraction breaker to the `breakers` record passed to
  `new HealthService(...)` (`src/index.ts:106-109`) — see design.md's Decisions on why
  it's excluded from aggregate health status; it still gets `logger` for transition
  logging.

## 4. Metrics

- [ ] 4.1 In `src/health/metrics.ts`, add (mirroring `embedding_embed_batch_ms`'s
  pattern at `src/embedding/index.ts:73`): `extraction_ms` histogram, and counters
  `extraction_fallback_total` (extraction attempted but fell back to single-candidate,
  any reason), `extraction_candidates_truncated_total`,
  `extraction_candidate_failed_total`.

## 5. Tests

- [ ] 5.1 `src/pipeline/extraction.test.ts`: `LlmExtractionProvider` returns validated
  candidates on a well-formed response; returns `null` on malformed JSON, on a
  schema-invalid response (missing `content`, empty array, all-empty-after-trim
  candidates), on a timeout (mock `AbortController` firing), and on a fetch rejection.
  Truncation at `extraction_max_candidates` drops overflow and logs/counts it.
  `createExtractionProvider` returns `NoopExtractionProvider` when disabled and when no
  key resolves (test both `extraction_model_env` and `OPENAI_API_KEY` fallback paths).
- [ ] 5.2 `src/pipeline/index.test.ts`: `extract()` calls the extraction provider only
  when normalized content length is at or above `extraction_min_chars`; below the gate,
  extraction is never invoked (assert via `vi.fn()` call count) and a single candidate
  is emitted. A well-formed multi-candidate extraction result produces N candidates
  each independently run through `decide()` (assert N `WriteResult`s, N calls to
  `storage.writeMemory`/`updateMemory` as appropriate). An extraction failure (provider
  throws or returns `null`) falls back to the existing single-candidate path with no
  behavior change from pre-change tests.
- [ ] 5.3 `src/pipeline/index.test.ts`: partial-batch failure — with 3 candidates where
  candidate 2's `decide()` throws (e.g. mock `getMemoryById` returning `null` on the
  second call), `process()` returns the 2 successful `WriteResult`s (not a rejected
  promise) and logs/counts the failure. All-candidates-fail case still rejects the
  `process()` call.
- [ ] 5.4 `src/config/index.test.ts` (or equivalent): `extraction_enabled` defaults to
  `false`; the three new fields validate their bounds and defaults (120 / 6 / 4000).
- [ ] 5.5 `src/tools/index.test.ts`: `handleRemember` returns an array (not collapsed)
  when `pipeline.process` resolves with more than one `WriteResult`, exercising the
  already-existing branch at `src/tools/index.ts:153` with a live multi-candidate
  scenario instead of a single-candidate mock.

## 6. Docs

- [ ] 6.1 `README.md`: update the `pipeline` config block (`README.md:491-501`) to
  document the three new fields and the `extraction_enabled` default flip; update the
  `remember` tool reference (`README.md:2294-2359`) to show the array response shape
  when extraction splits input into multiple candidates, with an example; note in the
  environment variable table (`README.md:519`) that the fallback described there is now
  actually implemented (wording likely needs no change, just confirm it still reads
  accurately once the behavior exists).
- [ ] 6.2 Propagate the same README changes to `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md` (section-for-section mirror, per `CLAUDE.md`).
- [ ] 6.3 `AGENTS.md`: no structural change expected (config-vs-environment section
  already describes `extraction_model_env`'s role correctly), but re-read it after
  implementation to confirm no drift.
- [ ] 6.4 Bump `package.json` `version` (user-visible: new config fields, changed
  default, new response shape reachable for the first time).

## 7. Spec sync

- [ ] 7.1 Confirm `openspec/changes/add-multi-candidate-extraction/specs/write-decision-pipeline/spec.md`
  (this change) accurately reflects the shipped behavior once 1-6 are complete —
  particularly the degraded/fallback and cost-bound scenarios — before archiving.

## 8. Validation

- [ ] 8.1 `npm run lint` (tsc --noEmit + eslint, including `no-explicit-any` on the new
  extraction response parsing — validate with Zod, never cast through `any`).
- [ ] 8.2 `npm test`.
- [ ] 8.3 Confirm README ×5 stayed in sync (task 6.2) and `package.json` version bumped
  (task 6.4) before marking this change done.
