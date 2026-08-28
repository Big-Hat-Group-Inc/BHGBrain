## Context

`WritePipeline.decide` (`src/pipeline/index.ts:82-289`) embeds the candidate, retrieves
the top 10 similar memories from Qdrant (`src/pipeline/index.ts:136-141`), and hands
the top match to `classifyOperation` (`src/pipeline/index.ts:291-314`):

```ts
if (top.score >= thresholds.update && detectsInvalidation(candidateContent)) {
  return { op: 'DELETE', targetId: top.id };
}
if (top.score >= thresholds.noop) {
  return { op: 'NOOP', targetId: top.id };
}
if (top.score >= thresholds.update) {
  return { op: 'UPDATE', targetId: top.id };
}
return { op: 'ADD' };
```

`detectsInvalidation` (`src/domain/normalize.ts:52-54`) is a pure regex test over nine
deterministic patterns (`src/domain/normalize.ts:36-51`): "no longer", "not true
anymore", "is outdated", "that's wrong/incorrect/false", "correction:"/"retraction:",
"forget that/this", "delete that/this (memory/fact)", "was incorrect", "actually, that
is wrong/false". Nothing outside that list can ever produce `DELETE`.

The UPDATE band is **not** a flat `[0.92, 0.98)` as the brainstorm's shorthand
suggests — `MemoryLifecycleService.dedupThresholdFor` (`src/domain/lifecycle.ts:
101-120`) makes it tier-dependent, floored by `deduplication.similarity_threshold`
(default `0.92`, `src/config/index.ts:148`):

| Tier | `update` floor | `noop` ceiling |
|---|---|---|
| T0 / T1 | `max(base, 0.95)` | `0.98` |
| T2 | `base` (0.92 default) | `0.98` |
| T3 | `max(base, 0.9)` | `0.95` |

So the UPDATE band this proposal targets is whatever `[thresholds.update,
thresholds.noop)` resolves to for the candidate's assigned tier — verify against
current code at implementation time, not against this table if thresholds have moved.

**No LLM chat-completion call path exists anywhere in this codebase today.** Verified
by search: `src/embedding/index.ts` and `src/embedding/azure-foundry.ts` both call
`/embeddings`, never `/chat/completions`; `pipeline.extraction_model` and
`pipeline.extraction_model_env` (`src/config/index.ts:212-214`) are validated Zod
fields with no consumer except a TODO in `WritePipeline.extract`
(`src/pipeline/index.ts:65-73`) reserving them for a future LLM-backed multi-candidate
extraction stage that has not landed. `openspec/changes/` has no proposal (as of
2026-08-28) that adds one either.

The DELETE-and-replace lineage this proposal reuses already exists
(`src/pipeline/index.ts:197-248`): delete the matched memory, write a new one with
`merged_from` set to the deleted id and `last_operation: 'DELETE'`.
`surface-memory-revision-history` (sibling proposal) reads `memory_revisions` rows
written only on `UPDATE` (`src/storage/sqlite.ts:1310`, inserted from
`StorageManager.updateMemory`); `SqliteStorage.deleteMemory`
(`src/storage/sqlite.ts:615-622`) deletes only from `memories` and `memories_fts` —
it does **not** touch `memory_revisions`. Those rows become orphaned (unreachable,
since resources resolve the memory by id first) whenever any DELETE-and-replace path
fires, including the one this proposal adds a second trigger for.

## Goals / Non-Goals

Goals:
- Catch semantic contradictions inside the UPDATE similarity band that phrase-based
  `detectsInvalidation` misses (the "Postgres vs. MySQL" case).
- Keep the regex fast path as the free, instant, zero-dependency trigger for writes
  that already phrase themselves as corrections — never add LLM latency to that path.
- Fail open: an LLM error, timeout, or missing credential must never block, delay
  indefinitely, or reject a write. Worst case is silently falling back to today's
  behavior.
- Ship default-off so no existing operator is silently charged latency/cost or
  surprised by new DELETE behavior on upgrade.

Non-Goals:
- Not detecting contradictions outside the UPDATE band. Below the UPDATE floor,
  Qdrant's top-10 retrieval may not even surface a genuinely conflicting memory as a
  candidate to compare against; above the NOOP ceiling, candidates are treated as
  exact-enough duplicates and this proposal does not change that.
- Not building a general-purpose LLM client or gateway — only the minimal
  single-purpose call needed for the three-way entailment classification, and only if
  the prerequisite call path does not already exist when this is implemented (see
  Decisions).
- Not changing `detectsInvalidation`'s pattern list or removing it.
- Not fixing `memory_revisions` orphaning on delete-and-replace — flagged as a risk
  below, left for a `surface-memory-revision-history` follow-up.
- Not distinguishing `agree` from `refine` in pipeline behavior in this pass (see
  Decisions) — both map to the existing UPDATE merge.

## Decisions

- **Prerequisite / gating (read this first)**: this proposal cannot reach a working
  state without a chat-completion call path behind `pipeline.extraction_model` /
  `pipeline.extraction_model_env`. Two ways to satisfy that, and the implementer must
  pick one explicitly rather than assume it exists:
  1. **Reuse a sibling's client**, if by the time this is implemented a proposal such
     as an `add-multi-candidate-extraction` has landed and exposes a shared
     chat-completion client wired to those two config fields. Prefer this — it avoids
     a second, divergent LLM client in the codebase.
  2. **Add the minimal client here**, if no such sibling exists yet (true as of
     2026-08-28 — confirmed no matching proposal in `openspec/changes/`). Task 1 below
     specifies a single-purpose `fetch`-based call modeled on
     `OpenAIEmbeddingProvider`'s pattern (`src/embedding/index.ts:37-88`: `fetch` to a
     provider endpoint, API key resolved from the env var named by config, JSON
     request/response, no SDK dependency) — scoped only to the three-way entailment
     classification, not a reusable extraction framework.

  Either way, this proposal's own tasks (2 onward) assume the call exists; do not
  start pipeline integration before this is resolved.

- **Fast-path ordering, not replacement**: `detectsInvalidation` is checked first and
  short-circuits — no LLM call — whenever it matches. The LLM check only runs when (a)
  the regex does not match, (b) the top similarity score is inside the UPDATE band for
  the candidate's tier, and (c) `pipeline.contradiction_detection.enabled` is true.
  This keeps explicit corrections free and instant, and keeps the two mechanisms from
  racing: regex always wins when it fires, so there is exactly one deterministic
  answer per write, never a disagreement to reconcile.

- **Three-way classification, two-way effect**: the entailment call returns
  `agree` / `refine` / `contradict`. Only `contradict` changes pipeline behavior
  (routes to the existing DELETE-and-replace path). `agree` and `refine` both fall
  through to the existing UPDATE merge, identical to today's behavior for anything
  that doesn't trip the regex. Keeping the three-way response (rather than a boolean)
  leaves room for a future refinement — e.g. `agree` routing to `NOOP` instead of
  `UPDATE` to avoid bumping `updated_at` on a pure rephrase — without a response-shape
  change, but that distinction is explicitly out of scope here to keep this a
  medium-effort, single-purpose change.

- **Fail-open on any LLM failure**: timeout, network error, non-2xx response, or
  unparseable classification all fall back to the current default (treat as if
  `contradiction_detection` were disabled for this write — proceed to UPDATE via the
  existing band logic) and log a degraded-path warning, mirroring the existing
  `fallback_to_threshold_dedup` pattern (`src/pipeline/index.ts:122-131`,
  `this.logger?.warn({ event: 'degraded_write', ... })`). A contradiction check must
  never throw out of `classifyOperation` and must never delay a write past
  `timeout_ms`.

- **Config default-off, credentials reused**: `pipeline.contradiction_detection.
  enabled` defaults to `false`. When enabled, model and API key resolution reuse
  `pipeline.extraction_model` / `pipeline.extraction_model_env` verbatim — no new
  secret-handling surface, consistent with the "Config vs. environment" contract in
  `AGENTS.md` (env vars only supply secrets/runtime overrides, never settings). The
  schema can validate shape but not reachability; a misconfigured `enabled: true`
  without valid credentials falls into the fail-open path on every UPDATE-band write
  from the first request (logged each time, not fatal, not retried in a loop).

- **`merged_from` lineage reused verbatim**: the `contradict` path calls the exact
  same delete-then-recreate sequence the regex trigger already uses
  (`src/pipeline/index.ts:197-248`) — no new columns, no new `WriteResult` fields.
  `last_operation: 'DELETE'` and `merged_from: <deleted id>` are indistinguishable
  between a regex-triggered and an LLM-triggered delete; if that distinction becomes
  valuable later (e.g. for audit/debugging which trigger fired), it needs a new field,
  out of scope here.

## Risks / Trade-offs

- **Two overlapping DELETE triggers**: keeping the regex fast path rather than
  replacing it means two mechanisms can, in principle, disagree (regex says
  invalidate; had the LLM run, it might have said `refine`). This is mitigated, not
  eliminated, by regex always taking priority — there is one deterministic answer per
  write, but it means the LLM's classification is never consulted when regex already
  matched, so a false-positive regex trigger cannot be caught by the smarter check.
  Replacing regex entirely was considered and rejected: it would add LLM latency to
  every explicit correction, the one case that already works well and cheaply today.

- **`memory_revisions` orphaning gets a second trigger**: contradiction-triggered
  deletes route through the same path that already orphans revision history for
  regex-triggered deletes (see Context). This proposal does not fix that gap, only
  adds another way to reach it — worth flagging explicitly to
  `surface-memory-revision-history` as a follow-up (e.g. carrying the deleted
  memory's revisions forward under the new id via `merged_from`, or letting the
  `memory://{id}/revisions` resource resolve through one hop of `merged_from` when the
  direct id is gone). Not implemented here to keep scope to the contradiction gap.

- **False contradictions are strictly worse than false negatives**: today's gap is a
  false *negative* — a real contradiction goes undetected and both memories persist
  (recoverable: a later explicit correction still fixes it). An LLM misclassifying
  `refine` as `contradict` is a false *positive* that silently deletes a memory that
  was still true — worse, because delete-and-replace does not preserve the deleted
  memory's content in `memory_revisions` (see orphaning risk above), so the loss is
  not trivially recoverable. Mitigate with conservative prompting (temperature 0,
  a real "no strong signal → not contradict" default), default-off shipping, and
  documenting the trade-off in `README.md` so operators opt in with eyes open.

- **Latency and cost on the write path**: a synchronous per-write LLM call for
  UPDATE-band candidates adds real latency (typically hundreds of ms) and per-call
  cost when enabled. `timeout_ms` bounds the worst case; operators who enable this
  must budget for it. Not a risk while default-off, but a real one for anyone who
  turns it on at write volume.

- **Dependency risk on the prerequisite**: if a future multi-candidate-extraction
  proposal lands with a differently-shaped client after this proposal ships its own
  minimal client (Decision, option 2), the two need consolidating — flagged so the
  implementer of whichever lands second does that consolidation rather than leaving
  two divergent LLM callers in `src/pipeline/`.
