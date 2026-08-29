## 0. Gate check (do this before task 1)

- [x] 0.1 Re-check `openspec/changes/` for a landed or in-progress proposal that
  already wires `pipeline.extraction_model` / `pipeline.extraction_model_env`
  (`src/config/index.ts:212-214`) to a working chat-completion call path (e.g. a
  future `add-multi-candidate-extraction`). None existed as of 2026-08-28 — confirm
  this is still true before choosing a path. **Re-confirmed 2026-08-28**:
  `add-multi-candidate-extraction/tasks.md` is entirely unchecked (`[ ]`) and
  `grep -rl "chat/completions" src/` returns no hits — still no chat-completion call
  path anywhere in `src/`.
- [x] 0.2 If such a client now exists: skip task 1's client build and instead import
  and reuse it in task 2. If not: proceed with task 1 as written. Record which path
  was taken in this file (edit this task's checkbox line) so reviewers don't have to
  re-derive it. **Path taken: option 2 (build the minimal client here)** —
  `src/pipeline/entailment.ts`, per task 1.

## 1. Minimal entailment client (only if 0.2 chose "build it here")

- [x] 1.1 Add `src/pipeline/entailment.ts` exporting a single function, e.g.
  `checkEntailment(existing: string, candidate: string, config: BrainConfig):
  Promise<'agree' | 'refine' | 'contradict'>`, modeled on the `fetch`-based pattern in
  `OpenAIEmbeddingProvider` (`src/embedding/index.ts:37-88`): resolve the API key from
  `process.env[config.pipeline.extraction_model_env]`, POST to the provider's
  chat-completions endpoint with `config.pipeline.extraction_model`, a low/zero
  temperature, and a prompt constraining the response to exactly one of the three
  labels.
- [x] 1.2 Enforce `timeout_ms` (new config field, task 2.1) via `AbortController`,
  matching the timeout pattern already used for embedding calls if one exists in
  `src/embedding/index.ts`; on timeout, network error, non-2xx, or an unparseable/
  off-list response, throw a single typed error the caller in `src/pipeline/index.ts`
  can catch and fail open on — never let a malformed LLM response silently resolve to
  `contradict`.
- [x] 1.3 Unit tests for `entailment.ts` (`src/pipeline/entailment.test.ts`): each of
  the three valid labels round-trips from a mocked fetch response; timeout throws;
  non-2xx throws; malformed/unlisted label throws (not silently coerced).

## 2. Config schema

- [x] 2.1 Add `pipeline.contradiction_detection` to the Zod schema
  (`src/config/index.ts`, alongside the existing `pipeline` block at lines 210-215):
  `enabled: z.boolean().default(false)`, `timeout_ms: z.number().int().positive()
  .default(<pick a value consistent with the embedding provider's own timeout
  default, if one exists in src/embedding/index.ts — otherwise 5000>)`. Do not
  duplicate `extraction_model` / `extraction_model_env` — reference the existing
  `pipeline.extraction_model` / `pipeline.extraction_model_env` fields at call sites
  instead of adding parallel config keys.
  Depends on: none.
- [x] 2.2 Add a schema test asserting the new block's defaults (`enabled: false`,
  the chosen `timeout_ms`) and that `enabled: true` with a missing/invalid
  `extraction_model_env` still passes Zod validation (reachability is a runtime
  concern per design.md, not a config-shape concern).
  Depends on: 2.1.

## 3. Pipeline integration

- [x] 3.1 In `classifyOperation` (`src/pipeline/index.ts:291-314`), keep the existing
  `detectsInvalidation` branch first and unchanged. Add a second branch, reached only
  when that regex did not match and the score is in `[thresholds.update,
  thresholds.noop)`: if `config.pipeline.contradiction_detection.enabled`, call the
  entailment check (from task 1 or the reused prerequisite client per task 0.2) and
  route `contradict` to `{ op: 'DELETE', targetId: top.id }`; `agree`/`refine` (or any
  fail-open outcome) fall through to the existing `{ op: 'UPDATE', targetId: top.id }`
  return already at line 310-312 — do not duplicate that return.
  Depends on: 1 (or 0.2's reused client), 2.1.
- [x] 3.2 `classifyOperation` currently is synchronous
  (`src/pipeline/index.ts:291-296` signature) but the entailment call is async — widen
  its signature to `Promise<...>` and update its one call site in `decide()`
  (`src/pipeline/index.ts:143`) to `await`. Confirm no other callers exist
  (`grep -rn "classifyOperation" src`) before changing the signature.
  Depends on: 3.1.
- [x] 3.3 Wire the fail-open path: wrap the entailment call in try/catch (or use the
  typed error from task 1.2); on any failure, log via the existing
  `this.logger?.warn({ event: 'degraded_write', ... })` shape used in
  `deterministicFallback`'s caller (`src/pipeline/index.ts:122-131`) with a
  distinguishing `event` value (e.g. `contradiction_check_degraded`), and proceed as
  if `contradiction_detection` were disabled for that write.
  Depends on: 3.1.
- [x] 3.4 Confirm the `contradict` path produces an identical `WriteResult` shape to
  the existing regex-triggered `DELETE` path (`src/pipeline/index.ts:197-248`) — no
  new fields, `merged_with_id` set, `operation: 'DELETE'`. No code change expected
  here if task 3.1 routes into the existing branch; this is a verification task.
  Depends on: 3.1.

## 4. Tests

- [x] 4.1 `classifyOperation`/`decide` test: candidate in the UPDATE band, regex does
  not match, entailment mock returns `contradict`, `contradiction_detection.enabled:
  true` → expect `DELETE` with `merged_from` set on the new record (extend
  `src/pipeline/index.test.ts`).
- [x] 4.2 Same setup with entailment mock returning `agree` and separately `refine` →
  expect `UPDATE`, existing merge behavior unchanged.
- [x] 4.3 Regex-match case: candidate matches `detectsInvalidation` → entailment mock
  must NOT be called (assert zero invocations) → `DELETE`, same as pre-change
  behavior.
- [x] 4.4 `contradiction_detection.enabled: false` (default) → entailment mock must
  NOT be called regardless of band/content → behavior identical to pre-change
  pipeline.
- [x] 4.5 Fail-open test: entailment mock throws / times out → `UPDATE` (not an
  error surfaced to the caller, not a dropped write), degraded-path log emitted.
- [x] 4.6 Regression: existing `src/pipeline/index.test.ts` NOOP/UPDATE/ADD/regex-
  DELETE cases still pass unmodified with `contradiction_detection.enabled: false`
  (the default) — confirms zero behavior change for operators who don't opt in.

## 5. Docs & validation

- [x] 5.1 Update the write-pipeline decision table in `README.md` (around
  `README.md:1211-1225`) to add the `contradiction_detection` DELETE trigger as an
  opt-in alternative to the invalidation-phrase trigger, and document the new
  `pipeline.contradiction_detection.{enabled,timeout_ms}` config fields plus the
  "reuses `extraction_model`/`extraction_model_env`" note and the default-off/
  fail-open/data-loss trade-off from design.md Risks.
  Depends on: 3, 4.
- [x] 5.2 Mirror the same README changes into `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md` — section-for-section per `CLAUDE.md`'s
  translation-sync rule.
  Depends on: 5.1.
- [x] 5.3 Update `AGENTS.md`'s "Config vs. environment" section only if this proposal
  changes how `extraction_model_env` is described (it should not — the env var's role
  is unchanged, only a new consumer is added); otherwise, no edit needed and this task
  closes as "not applicable" with the reasoning noted, per the pattern in
  `add-composite-recall-ranking/tasks.md` task 1.2. **Not applicable**: confirmed
  `AGENTS.md`'s "Config vs. environment" section still accurately describes
  `pipeline.extraction_model_env` as "the name of the env var to read" — this
  proposal adds a second consumer (`checkEntailment` in `src/pipeline/entailment.ts`)
  of the same existing env var, not a new env var or a change to how it resolves. No
  edit made.
  Depends on: 5.1.
- [x] 5.4 Bump `package.json` `version` (user-visible behavior change once enabled).
  Bumped `1.12.0` → `1.13.0` (minor: additive, opt-in feature). `package-lock.json`'s
  top-level `version` field was already stale relative to `package.json` before this
  change (`1.6.0` vs `1.12.0`) and is not hand-maintained in this repo — left as-is,
  consistent with that existing pattern.
  Depends on: 5.1.
- [x] 5.5 Run `npm run lint` (tsc --noEmit + eslint, no `any` casts) and `npm test`;
  fix until both pass clean. Verified 2026-08-28: `npm run lint` (tsc --noEmit +
  eslint src) clean, `npm test` 31 files / 533 tests passing (includes the new
  `src/pipeline/entailment.test.ts` and the extended `src/pipeline/index.test.ts` /
  `src/config/index.test.ts`).
  Depends on: 1, 2, 3, 4.
