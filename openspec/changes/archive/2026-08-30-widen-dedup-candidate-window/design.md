## Context

- `WritePipeline.decide()` (`src/pipeline/index.ts:82-143`) fetches near-neighbors via
  `this.storage.qdrant.searchSimilar(input.namespace, input.collection, vector, 10)`
  (`:136-141`) and passes the full result plus the candidate content and assigned tier
  to `classifyOperation(candidate.content, similar, tier)` (`:143`).
- `classifyOperation` (`:291-313`) discards everything past index 0:
  `if (similar.length === 0) return { op: 'ADD' }; const top = similar[0]!;` and then
  compares only `top.score` against `this.lifecycle.dedupThresholdFor(tier, ...)`
  (`{ noop, update }`, `src/domain/lifecycle.ts:101-120`) plus `detectsInvalidation`
  (`src/domain/normalize.ts`) for the DELETE branch.
- `searchSimilar` (`src/storage/qdrant.ts:234-270`) returns candidates sorted
  descending by cosine score — Qdrant's `query()` API guarantees rank order — as
  `Array<{ id: string; score: number }>`, no payload. `fix-qdrant-client-search-removal`
  made this method propagate real Qdrant failures (`:251-269`) instead of coercing them
  to `[]`, so a non-empty window is now trustworthy end-to-end evidence rather than
  possibly a masked failure.
- `dedupThresholdFor` (`src/domain/lifecycle.ts:101-120`) returns
  `{ noop, update }` per tier, derived from the single `deduplication.similarity_threshold`
  config value (default `0.92`); T0/T1 tighten it to `max(base, 0.95)`, T3 loosens it to
  `max(base, 0.90)`, T2 uses the base value.
- The vectorless `deterministicFallback` path (`:337+`) has its own single-candidate
  flow over SQLite full-text results (`ftsMatches[0]`, `:369-375`) and does not go
  through `classifyOperation` at all — it is a separate, smaller decision surface with
  no 10-item window to widen.

## Goals / Non-Goals

Goals:
- Use more of the already-fetched top-10 similarity window in the classify decision,
  at effectively zero extra cost (no new Qdrant call, no new embedding call).
- Recognize a corroborated near-duplicate cluster — several existing memories
  independently near the UPDATE threshold — and merge new writes into the strongest of
  them instead of adding another variant.
- Keep the change conservative and disableable: corroboration only ever escalates
  `ADD` to `UPDATE`; `NOOP` and `DELETE` keep their existing single-candidate semantics.

Non-Goals:
- No change to the vectorless fallback path (`deterministicFallback`/`textSimilarity`)
  — it has no vector window to widen without issuing a second, separate FTS query,
  which is a different and smaller idea outside this brainstorm item.
- No change to `NOOP` or `DELETE` classification logic, and no change to which
  candidate is targeted for a decision that already clears its own threshold on
  `similar[0]`. This proposal does not re-litigate "is `similar[0]` the right
  NOOP/DELETE target" — it only adds a new `UPDATE` path for the case that is
  currently unconditionally `ADD`.
- No offline consolidation, clustering, or a `consolidate` tool for historic
  duplicates already in the store — that is `add-duplicate-cluster-consolidation`
  (brainstorm 5.1), a separate, larger, unbuilt proposal.
- No change to `deduplication.similarity_threshold` semantics/default, and no change
  to the per-tier threshold table in `dedupThresholdFor`.
- No hydration of SQLite metadata (recency, importance, archived status) for window
  candidates to pick a "more canonical" merge target than the highest raw score — see
  Risks below.

## Decisions

- **Window, not just top-1.** `classifyOperation` slices `similar` to
  `deduplication.candidate_window` (default 5, Zod-capped at 10, the hard ceiling
  already fetched by the hardcoded `searchSimilar(..., 10)` call at
  `pipeline/index.ts:140`). Because `similar` is already sorted descending,
  `window[0] === similar[0]` always, so the existing NOOP/DELETE/direct-UPDATE
  branches are unchanged byte-for-byte; only a new branch is added before the final
  `ADD` fallback.
- **Corroboration is UPDATE-only escalation.** When `top.score < thresholds.update`,
  count window members with `score >= thresholds.update - corroboration_margin`. If
  that count is `>= corroboration_count`, classify `UPDATE` targeting `top.id` — the
  single highest-scoring member of the corroborating group, since the window is
  already rank-ordered. This is deliberately the lowest-risk new behavior available:
  it can only turn an `ADD` into an `UPDATE` (never invents a `NOOP` or a `DELETE`),
  and it always targets the highest-scoring candidate, so the merge destination needs
  no new tie-breaking logic.
- **Defaults** (`candidate_window: 5`, `corroboration_count: 2`,
  `corroboration_margin: 0.03`): two corroborating neighbors within 0.03 of the
  UPDATE threshold is a deliberately narrow band — for the default
  `similarity_threshold` of 0.92, that means at least one *additional* memory besides
  the closest match scoring `>= 0.89`. False positives here cost a content merge, so
  the bar starts tight; operators with denser near-duplicate accumulation (e.g. after
  a bulk import) can widen `corroboration_margin` or lower `corroboration_count`
  without a code change.
- **Independent kill switch** (`deduplication.corroboration_enabled`, default `true`,
  separate from `deduplication.enabled`): mirrors the `search.ranking.enabled` pattern
  from `add-composite-recall-ranking` (`src/config/index.ts:166-177`) — a targeted off
  switch for just the new heuristic, distinct from disabling dedup entirely, so an
  operator who dislikes only the corroboration behavior isn't forced to also give up
  checksum + top-1 dedup.
- **Structured log on trigger** (`corroborated_dedup` warn event, via the existing
  `logger?.warn` field already used for `degraded_write` at
  `pipeline/index.ts:124-129`): gives operators visibility into how often the new path
  fires (useful for tuning `corroboration_margin`/`corroboration_count`) and gives a
  future `add-duplicate-cluster-consolidation` job an existing signal to mine, without
  this proposal needing to build any new storage for it.
- **No change to `searchSimilar`'s fetch count.** It stays hardcoded at `10`
  (`pipeline/index.ts:140`); `candidate_window` is Zod-capped at 10 so it can never
  request evaluation of more candidates than are fetched. Decoupling the fetch count
  from the window size was considered and rejected as unnecessary scope — 10 is
  already generous headroom over any sane `corroboration_count`.

## Risks / Trade-offs

- **False-positive merges.** A corroborated cluster could, in principle, be three
  memories about related-but-distinct facts that happen to embed closely (common with
  short, templated content). Mitigated by the tight default margin/count, the
  independent kill switch, and the fact that `UPDATE` preserves the *existing*
  memory's id and lineage — nothing is silently deleted; the merge is visible via
  `merged_with_id` and audit-logged exactly like any other `UPDATE`. A bad merge here
  is a content-quality issue, not a data-loss one.
- **Target-selection concentration.** Always merging into the single highest-scoring
  candidate can, over many writes, keep concentrating updates onto one record even
  when a different corroborating candidate would be the more "canonical" target (by
  recency, importance, or tier). This proposal deliberately does not hydrate SQLite
  metadata for window candidates to make that judgment — a per-candidate lookup is a
  bigger change than "small effort" for a decision this proposal treats as good
  enough. Picking the true canonical target across a whole cluster is left to
  `add-duplicate-cluster-consolidation`, which already has to solve that problem for
  clusters larger than the two-or-three-item window considered here.
- **Threshold coupling.** `corroboration_margin` is an absolute offset from the tier's
  `update` threshold, so its effective strictness shifts if `similarity_threshold` or
  a tier's threshold table changes. Documented in README rather than normalized/made
  relative, to keep the config surface small; a future change can revisit this if
  tuning proves awkward in practice.
- **Manual tuning only.** There is no automatic backoff if `corroborated_dedup` fires
  more than expected for a given deployment — it is a log line an operator has to
  notice and act on. Acceptable for a first cut given the kill switch is a one-line
  config change (`corroboration_enabled: false`).
