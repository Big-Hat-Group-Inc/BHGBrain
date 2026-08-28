## Why

`classifyOperation` (`src/pipeline/index.ts:291-314`) only reaches `DELETE` when a
candidate lands in the UPDATE similarity band *and* `detectsInvalidation` matches one
of nine deterministic regexes (`src/domain/normalize.ts:36-54`: "no longer", "not true
anymore", "is outdated", "that's wrong/incorrect/false", "correction:"/"retraction:",
"forget that", "delete this", "was incorrect", "actually, that is wrong/false"). Any
candidate that conflicts with an existing memory without using one of those exact
phrasings falls straight through to the existing `UPDATE` merge (`src/pipeline/
index.ts:162-195`) — or, if it lands below the UPDATE floor, becomes an unrelated
`ADD`. Either way, the stale fact survives and is recalled alongside the new one.

The brainstorm's example: "We migrated to Postgres" doesn't say anything the regex
list recognizes, so it silently coexists with "we use MySQL" — both memories persist,
both get recalled, and the agent has no signal which one is current. This is the
biggest correctness gap in a long-lived store: facts never die unless a write happens
to be phrased as an explicit correction.

## What Changes

- Add an opt-in, LLM-backed entailment check that fires **only** for candidates in the
  UPDATE similarity band (thresholds from `MemoryLifecycleService.dedupThresholdFor`,
  `src/domain/lifecycle.ts:101-120`) when the existing regex fast path does **not**
  already match. The check classifies the candidate against the matched memory as
  `agree` / `refine` / `contradict`.
- `contradict` routes through the same DELETE-then-recreate-with-`merged_from`-lineage
  path the regex trigger already uses (`src/pipeline/index.ts:197-248`); `agree` and
  `refine` both fall through to the existing UPDATE merge — no behavior change for
  those two outcomes in this pass.
- New config block `pipeline.contradiction_detection` (Zod schema, `src/config/
  index.ts`): `enabled` (default **false**), `timeout_ms`, and reuse of the existing
  `pipeline.extraction_model` / `pipeline.extraction_model_env` fields
  (`src/config/index.ts:212-214`) for the model name and API-key env var — no new
  secret-handling surface.
- On LLM error, timeout, or missing/invalid credentials: fail open to the current
  default (UPDATE merge, i.e. behave exactly as if the feature were disabled),
  logged as a degraded path — mirrors the existing `fallback_to_threshold_dedup`
  degraded-write pattern (`src/pipeline/index.ts:122-131`).
- The regex `detectsInvalidation` fast path is **kept, not replaced**, and always
  checked first — it stays the free, instant, zero-dependency trigger for writes that
  already phrase themselves as corrections; the LLM check only runs for the remaining
  UPDATE-band writes.
- **This proposal has a real, currently-unmet dependency**: no chat-completion call
  path exists anywhere in this codebase today (verified — the embedding providers in
  `src/embedding/` call `/embeddings`, never `/chat/completions`, and
  `pipeline.extraction_model`/`extraction_model_env` are validated Zod fields consumed
  nowhere except a TODO reserving them for future multi-candidate extraction,
  `src/pipeline/index.ts:65-73`). See `design.md` Decisions for the two ways to close
  this gap before the pipeline integration tasks can land.
- Document behavior, config, and the dependency caveat in `README.md` and its four
  translations; bump `package.json` version.

## Capabilities

### New Capabilities
- `contradiction-detection`: writes landing in the UPDATE similarity band are
  optionally checked for semantic agreement, refinement, or contradiction against the
  matched memory via an LLM entailment call, routing contradictions to
  DELETE-and-replace instead of silently merging into a stale fact.

### Modified Capabilities
- `write-decision-pipeline`: `classifyOperation`'s `DELETE` branch gains a second,
  LLM-backed trigger alongside the existing regex fast path (regex still checked
  first and short-circuits without an LLM call whenever it matches).

## Impact

- Affected code: `src/pipeline/index.ts` (`classifyOperation`, `decide`), a new
  entailment-check module under `src/pipeline/`, `src/config/index.ts`
  (`pipeline.contradiction_detection` schema), co-located tests.
- Behavior: default-off — zero behavior change until an operator opts in and has
  working extraction credentials. Once enabled, some UPDATE-band writes that
  previously merged silently now DELETE-and-replace with lineage.
- Cost/latency: adds a synchronous LLM call to the write path for UPDATE-band
  candidates when enabled; timeout-bounded and fail-open, but not free — see
  `design.md` Risks.
- Docs: `README.md` ×5 (write-pipeline decision table around `README.md:1211-1225`),
  `AGENTS.md` if config guidance changes, version bump. `.env.example` unchanged (no
  new env var — reuses `extraction_model_env`).
- Depends on: a working chat-completion call path behind `pipeline.extraction_model`/
  `extraction_model_env`. As of this writing that path does not exist in the
  codebase and no sibling proposal (e.g. an `add-multi-candidate-extraction`) is
  present in `openspec/changes/` to supply it. This proposal must either land after
  such a prerequisite exists and reuse its client, or implement the minimal client
  itself as its first task — see `design.md` Decisions, "Prerequisite / gating".
