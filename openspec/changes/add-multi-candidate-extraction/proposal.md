## Why

`extract()` (`src/pipeline/index.ts:61-80`) is single-candidate by construction: it
always returns exactly one `MemoryCandidate` — the normalized whole input — regardless
of `pipeline.extraction_enabled`. The TODO left at `src/pipeline/index.ts:68-73` says
so explicitly:

> implement LLM-backed multi-candidate extraction using `config.pipeline.extraction_model`
> to split multi-fact content into atomic candidates, or retire `extraction_enabled` /
> `extraction_model` if multi-candidate extraction stays out of scope.

`pipeline.extraction_enabled` and `pipeline.extraction_model` already exist in the Zod
schema (`src/config/index.ts:212-213`) and are already documented in `README.md:493-498`
and `AGENTS.md`'s "Config vs. environment" section — they read as live configuration but
do nothing today. This has already forced one spec walk-back: the original
`write-decision-pipeline` requirement declared multi-candidate extraction
(`openspec/changes/bootstrap-memory-core/specs/write-decision-pipeline/spec.md:3-12`),
and a later revision in the same file (`spec.md:96-109`) de-scoped it back to
"exactly one candidate ... for v1," noting the model-backed stage was never built.

The cost is concrete: a paragraph like "We use pnpm not npm, deploys go through GitHub
Actions, and Alice owns the infra repo" becomes one blob memory whose embedding is the
*average* of three unrelated facts. That blob dedups poorly (a later correction to only
one of the three facts can't checksum- or similarity-match cleanly against the blob),
recalls poorly (a query about "who owns infra" competes against two irrelevant facts
diluting the embedding), and can't be UPDATE-targeted per-fact. Splitting multi-fact
input into atomic, independently-dedupable, independently-recallable candidates is the
highest-leverage ingestion change available, and a declared prerequisite for two other
brainstormed ideas (contradiction detection, distillation) that need atomic candidates
to operate on — neither of which this change implements.

## What Changes

- Implement a real LLM-backed extraction stage: a chat-completion call (OpenAI-compatible,
  same key-resolution family as the existing embedding provider) that splits normalized
  input into 1..N atomic, self-contained candidate memories with per-candidate inferred
  `type`/`importance`, validated against a strict Zod-checked response schema before any
  candidate is trusted.
- Gate the LLM call behind cheap, deterministic guards so cost/latency is bounded and
  predictable: a minimum-length threshold below which extraction never fires (short
  content is assumed single-fact), a hard cap on candidates accepted per call, and a
  request timeout — all new `pipeline.*` config fields with conservative defaults.
- Flip the default of `pipeline.extraction_enabled` from `true` to `false`. The flag
  currently has zero effect, so every existing install already runs with it "on";
  changing what it *does* while leaving it defaulted-on would silently start spending
  LLM calls (and money) on every sufficiently-long `remember` for installs that never
  touched this setting. Operators opt in deliberately.
- Add a circuit breaker (`extraction`, same options shape as the embedding/Qdrant
  breakers) around the extraction call. Any failure mode — network error, timeout,
  malformed/empty JSON, an empty or over-limit candidate array — falls back to today's
  deterministic single-candidate extraction for that call. Extraction failure never
  blocks or fails a `remember` call.
- Make per-candidate write failures inside a multi-candidate batch non-fatal to sibling
  candidates: `process()` continues attempting remaining candidates after one throws,
  and returns every successful `WriteResult`, instead of losing already-persisted
  sibling writes to an unhandled rejection.
- No change to `decide()`'s per-candidate dedup/classification logic, `WriteResult`'s
  shape, or the `remember` tool's response contract — `handleRemember`
  (`src/tools/index.ts:133-154`) already collapses a length-1 result array to a single
  object and returns an array otherwise, so multi-candidate output is already a
  supported (if previously unreachable) response shape.

## Capabilities

### New Capabilities

### Modified Capabilities
- `write-decision-pipeline`: extraction now actually splits multi-fact content into
  atomic candidates when enabled, instead of always emitting exactly one candidate
  regardless of configuration.

## Impact

- Affected code: `src/pipeline/index.ts` (`extract()` becomes async and LLM-backed,
  `process()`'s per-candidate loop becomes fault-tolerant), a new
  `src/pipeline/extraction.ts` (provider + response validation, mirroring
  `src/embedding/index.ts`'s provider/degraded-provider/warn-if-degraded shape),
  `src/config/index.ts` (`pipeline.extraction_enabled` default flip + three new
  bounded-cost fields), `src/index.ts` / `src/cli/index.ts` (wire the extraction
  provider and its breaker into `WritePipeline`'s constructor), `src/health/metrics.ts`
  (new histogram/counters), co-located tests.
- Config default change: `pipeline.extraction_enabled` goes from `true` to `false`.
  Existing installs see no behavior change until an operator opts in.
- Behavior: with extraction enabled and a resolvable API key, sufficiently long
  `remember` calls may now return an array of `WriteResult` instead of a single object
  — an existing, already-implemented response shape, now reachable for the first time.
- Docs: README ×5 (`remember` tool reference, config reference block, environment
  variable table), `.env.example` comment already describes the intended key-fallback
  behavior and needs no wording change, version bump.
- Depends on: nothing landed. Explicitly does **not** couple to contradiction detection
  or distillation — those stay separate future proposals that would depend on this one
  having landed first, not vice versa.
