## Context

`WritePipeline.process()` (`src/pipeline/index.ts:29-59`) runs two phases: Phase A
(`extract()`) turns raw input into `MemoryCandidate[]`, Phase B (`decide()`) runs each
candidate through checksum dedup → embed → similarity-search → ADD/UPDATE/DELETE/NOOP
classification, independently, in a `for` loop. `decide()` already treats each
candidate as fully independent — it takes one `MemoryCandidate` and returns one
`WriteResult`. The loop structure in `process()` already supports N candidates; only
`extract()` (currently 15 lines that ignore its config entirely) needs to become real.

`handleRemember` (`src/tools/index.ts:133-154`) already does
`results.length === 1 ? results[0]! : results`, so the multi-candidate response shape
is already live code, just unreachable — `extract()` has only ever returned one
candidate since this repo's first commit of the pipeline.

The embedding provider stack (`src/embedding/index.ts`) is the template for adding a
second LLM-backed dependency: a concrete provider class, a `Degraded*Provider` that
never contacts the network and fails/no-ops predictably, a factory that falls back to
the degraded variant on missing credentials, a `warnIfXDegraded` startup log, and a
`CircuitBreaker` keyed per-dependency (`getEmbeddingBreakerKey`, wired in
`src/index.ts:63-64`). This change reuses that exact shape for extraction rather than
inventing a new pattern.

## Goals / Non-Goals

Goals:
- Split multi-fact input into atomic, independently dedupable/recallable candidates
  when `pipeline.extraction_enabled` is true and a usable model/key is configured.
- Bound the cost and latency impact of the LLM call: skip it for short content, cap
  candidates accepted per call, time-box the request, and circuit-break repeated
  failures so a bad extraction backend degrades to today's behavior rather than
  degrading every `remember` call's latency.
- Never let extraction failure (of any kind: network, timeout, malformed output, empty
  output) block a write. Every failure mode resolves to the existing deterministic
  single-candidate path.
- Keep `decide()`, `WriteResult`, and the `remember` tool's response contract
  unchanged — this is purely a Phase A (extraction) change.

Non-Goals:
- **Contradiction detection** (brainstorm 2.4) and **distillation** (brainstorm 3.2) do
  not ship here. Both are described in the brainstorm as building on atomic candidates
  that this change produces, but neither is implemented, stubbed, or partially wired in
  this change. They stay separate future proposals with their own design review, and
  they depend on this one having landed — not the reverse.
- No cross-candidate reasoning within one batch. If a single input paragraph contains
  two candidates that contradict each other, each is decided independently by the
  existing per-candidate classifier; any resulting UPDATE/DELETE relationship between
  them is incidental to normal similarity-based dedup, not a designed feature of this
  change.
- No Azure Foundry extraction backend. `pipeline.extraction_model`/
  `extraction_model_env` have no Azure-resource-name counterpart the way
  `embedding.azure.resource_name` does; this change scopes the extraction provider to
  OpenAI-compatible chat completions only. Azure parity is a follow-up if needed.
- No batched-embedding optimization across candidates from one extraction call.
  `decide()`'s checksum-dedup step (Step 1) can resolve a candidate as NOOP before an
  embedding is ever requested; embedding every candidate up front (via the existing
  `embedBatch`) would spend embedding calls on candidates that turn out to be free
  checksum hits. Restructuring `decide()` into a batched two-pass pipeline is left for
  a future change if extraction call volume makes it worth the added complexity.
- No new MCP tool, schema, or resource surface. Extraction is entirely internal to
  `remember`'s existing pipeline.

## Decisions

- **Provider shape mirrors embeddings.** `src/pipeline/extraction.ts` exports an
  `ExtractionProvider` interface (`extractCandidates(content): Promise<RawCandidate[]>`),
  an `LlmExtractionProvider` implementation (chat completions, `response_format:
  {type:'json_object'}`, model = `config.pipeline.extraction_model`), a
  `NoopExtractionProvider` (returns `null` to signal "no extraction attempted" — used
  when `extraction_enabled` is false or no key resolves), a
  `createExtractionProvider(config, options)` factory, and a `warnIfExtractionDegraded`
  startup log — the same five pieces `src/embedding/index.ts` has for embeddings.
- **Key resolution matches the documented (but previously unimplemented) fallback.**
  `README.md:519` already documents `BHGBRAIN_EXTRACTION_API_KEY` as falling back to
  `OPENAI_API_KEY` when unset; nothing implemented that because extraction didn't
  exist. This change implements exactly that: `process.env[extraction_model_env] ??
  process.env.OPENAI_API_KEY`. If neither resolves, extraction is silently unavailable
  for this run's writes (`NoopExtractionProvider`), logged once at startup like a
  degraded embedding provider, not re-logged per request.
- **`extraction_enabled` default flips `true` → `false`.** The flag is live
  configuration today that does nothing; every existing install already has it
  effectively "on" with zero consequence. Making it do something real while leaving the
  default on would retroactively opt every upgraded install into LLM spend and latency
  it never asked for. Flipping the default is a deliberate, documented behavior change
  (README + version bump) rather than a silent capability upgrade.
- **Cost/latency bounds are config, not hardcoded.** Three new `pipeline.*` fields:
  `extraction_min_chars` (default 120 — content shorter than this skips the LLM call
  entirely and goes straight to single-candidate extraction, since a short input is
  overwhelmingly likely to already be one atomic fact), `extraction_max_candidates`
  (default 6 — candidates beyond the cap are dropped with a warning log and a
  `extraction_candidates_truncated_total` counter, not merged back), `extraction_timeout_ms`
  (default 4000 — enforced via `AbortController` on the chat-completions fetch).
- **Response validation is strict, not best-effort.** The chat completion's JSON body
  is parsed and checked against a Zod schema (`candidates: array, min 1, each with
  non-empty trimmed `content`, optional `type` in the existing `MemoryType` enum,
  optional `importance` in `[0,1]`). Any parse failure, schema failure, empty array, or
  every-candidate-empty-after-trim result is treated identically to a network failure:
  fall back to single-candidate extraction for that call. No partial trust of a
  malformed response — either every candidate in the batch is well-formed, or none of
  them are used.
- **Extraction failure and `fallback_to_threshold_dedup` are independent, stackable
  degradations.** `fallback_to_threshold_dedup` governs Phase B's response to an
  *embedding* failure inside `decide()` (`src/pipeline/index.ts:120-133`), which runs
  once per candidate, after extraction has already produced candidates. Extraction
  failure is resolved entirely within Phase A, before `decide()` is ever called for any
  candidate. The two can compound in one call — extraction fails → one deterministic
  candidate is emitted → that candidate's embedding also fails →
  `deterministicFallback` runs — but neither flag/path changes the other's behavior.
  This is called out explicitly so the interaction isn't assumed to be one fallback
  chain when it is two independent ones.
- **Checksum dedup already degrades gracefully to similarity dedup on re-submission,
  and that's an accepted trade-off, not a bug to fix here.** Today, checksum dedup
  (`decide()` Step 1, `src/pipeline/index.ts:107`) hits because the same raw input
  produces the same normalized checksum on resubmission. Once extraction rewrites
  content into per-candidate atomic phrasing, the LLM is not guaranteed to reproduce
  byte-identical candidate text for the same input across two separate calls (models
  are not required to be deterministic even at low temperature). A resubmitted
  paragraph may therefore miss the free checksum-NOOP fast path and fall through to the
  embedding + similarity path instead — still correct (NOOP is still reached), just
  paying for an embedding call and a Qdrant search it wouldn't have paid before
  extraction existed. This is documented in Risks below rather than "solved" (e.g. by
  requesting verbatim-preserving extraction) because enforcing verbatim splitting
  defeats the purpose of atomic, self-contained candidates in the first place.
- **Partial-batch write failures are logged and skipped, not silently swallowed or
  fatal to siblings.** `process()`'s per-candidate loop wraps `decide()` in try/catch;
  a candidate that throws is logged (`event: 'candidate_write_failed'`, with namespace
  and candidate index) and counted (`extraction_candidate_failed_total`), and the loop
  continues to the next candidate. If every candidate in the batch failed, `process()`
  rethrows the last error (preserving today's all-fail-throws behavior for the common
  single-candidate case, where "every candidate failed" and "the call failed" are the
  same thing). If at least one candidate succeeded, `process()` returns the successful
  `WriteResult[]` without throwing. The accepted limitation: a caller cannot tell from
  the response alone that N-of-M candidates were dropped versus that the input only
  ever produced N candidates — extraction is opaque to the caller by design, so this is
  observable only via logs/metrics, not the tool response. See Risks.
- **The extraction circuit breaker is not wired into `HealthService`'s aggregate
  status.** `HealthService.computeOverall` (`src/health/index.ts:238`) marks the whole
  server `degraded` if *any* registered breaker is open. Embedding/Qdrant breakers
  gating core functionality earning that escalation is correct; extraction is a
  best-effort enhancement with a fully-functional fallback, so an open extraction
  breaker forcing every `/health` check and dependent alerting to fire would be a false
  alarm. The breaker still gets a `logger` (per `CircuitBreakerOptions.logger`), so
  state transitions are visible in structured logs exactly like the other breakers —
  it's just excluded from the `breakers` record passed to `new HealthService(...)`.

## Risks / Trade-offs

- **Model dependency and non-determinism.** Extraction quality (correct fact
  boundaries, correct atomicity, not hallucinating content not in the input) is
  entirely dependent on the configured model's behavior and is not something this
  change can guarantee or test exhaustively — only the failure-handling and validation
  around it. A model that "extracts" by paraphrasing beyond recognition, or that merges
  facts back together instead of splitting them, degrades recall quality in ways that
  look like a regression but are a model-behavior problem, not a pipeline bug. The
  mitigation is bounding blast radius (candidate cap, length gate) and strict schema
  validation, not correctness guarantees on model output.
- **Cost and latency budget.** Every gated `remember` call that reaches the LLM adds a
  network round trip (bounded by `extraction_timeout_ms`) and per-token cost. The
  length gate (`extraction_min_chars`) and default-off flip limit exposure, but an
  operator who enables this for high-volume `agent`-sourced writes should expect a
  material latency and spend increase on the `remember` path — this is inherent to the
  feature, not a bug to engineer away.
- **Malformed/empty LLM output.** Handled by strict Zod validation with an
  all-or-nothing fallback (see Decisions). The risk that remains: a *technically valid*
  but semantically poor response (e.g., one candidate that's just the word "yes")
  passes schema validation and is written as-is. This change validates shape, not
  semantic quality; a semantic-quality gate (e.g., minimum candidate length beyond
  "non-empty") is a cheap follow-up but is not included here to keep the validation
  surface simple and predictable.
- **Partial-failure mid-batch.** Already an existing architectural gap — `decide()`'s
  writes are not transactional across SQLite and Qdrant, and `process()` has never
  supported rolling back a partially-completed multi-write call — but it was
  effectively unreachable when every call produced exactly one candidate (a
  single-candidate failure and a whole-call failure were the same event). Multi-candidate
  extraction makes 3-8-candidate batches routine, so "candidate 2 of 5 throws" becomes a
  realistic, not theoretical, occurrence. This change makes the failure non-fatal to
  siblings (see Decisions) but does not add cross-store transactions; a candidate that
  writes successfully but whose sibling fails is still fully persisted and audit-logged
  (`storage.logAudit`), just potentially not reported in *this* call's response if it's
  the one that failed. Full transactional batch semantics are out of scope.
- **Interaction with checksum dedup and `fallback_to_threshold_dedup`.** Covered in
  Decisions: the two fallback paths are independent and can stack, and extraction
  rewriting content means checksum dedup's free-fast-path hit rate on resubmitted
  multi-fact input will drop (falls through to the still-correct but costlier
  similarity path). This is a real, expected regression in dedup *efficiency* (not
  *correctness*) for that specific access pattern, traded for the recall/dedup
  precision gains atomic candidates provide everywhere else.
- **Ordering change risk to existing tests/consumers of `remember`'s response shape.**
  Any caller that assumed `remember` always returns a single object (rather than
  branching on array-vs-object, as `handleRemember` already does) will break once
  multi-candidate output becomes reachable for the first time. Mitigated by the
  default-off flip: this is opt-in, and the response-shape branching already exists in
  the tool layer and is documented as part of this change's README updates.
