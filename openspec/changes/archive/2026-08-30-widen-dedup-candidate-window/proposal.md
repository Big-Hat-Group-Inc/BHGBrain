## Why

`classifyOperation` (`src/pipeline/index.ts:291-313`) fetches up to 10 near-neighbors
via `searchSimilar` (`src/pipeline/index.ts:136-141`, calling
`src/storage/qdrant.ts:234-270` with `topK=10`) and then throws away everything past
index 0:

```ts
if (similar.length === 0) return { op: 'ADD' };
const top = similar[0]!;
```

Every threshold comparison — NOOP, the invalidation-driven DELETE, and UPDATE — is made
against `top` alone. The other up-to-nine candidates the pipeline already paid a Qdrant
round trip for are discarded unread.

The concrete failure mode: if a candidate's single closest match sits just under the
tier's UPDATE threshold, but several *other* existing memories independently cluster at
a similar score (all near-restatements of the same fact), the write still ADDs a fresh
variant — because the classifier never notices the second, third, or fourth
near-duplicate, only the first. `README.md:818` already names the symptom this produces
in the embedding-provenance write-up ("deduplication (`similar[0]` scores ...) silently
corrode"), though that note is about cross-model drift; the same single-candidate
narrowness limits dedup quality even with a perfectly consistent embedding space.

This is newly worth fixing: `fix-qdrant-client-search-removal` (BIG-80) made
`searchSimilar` propagate real Qdrant failures instead of silently returning `[]`
(`src/storage/qdrant.ts:251-269`), so a non-empty 10-candidate window is now a
trustworthy signal end-to-end rather than one that could be a masked failure. Before
that fix, widening the decision window would have meant trusting data that might
secretly be a degraded empty result; now it's safe to use.

No model or extraction dependency is involved — every input to a richer decision
(scores, tier, thresholds) is already resident in memory by the time `classifyOperation`
runs, making this a pure algorithm change.

## What Changes

- Widen `classifyOperation`'s decision window from `similar[0]` to the top
  `deduplication.candidate_window` (default 5, Zod-capped at 10 — the ceiling already
  fetched) candidates of the same, already-issued `searchSimilar` result. No additional
  Qdrant round trip or embedding call.
- Add a corroboration path: when the single closest candidate does not independently
  clear the tier's UPDATE threshold, but at least `deduplication.corroboration_count`
  (default 2) candidates within the window score within
  `deduplication.corroboration_margin` (default 0.03) of that threshold, classify
  `UPDATE` against the strongest (highest-scoring) of them instead of `ADD`.
- Scope the new behavior narrowly: corroboration only ever escalates `ADD` → `UPDATE`.
  `NOOP` and `DELETE` keep their existing single-candidate (`similar[0]`) semantics
  unchanged — this proposal does not touch the higher-severity branches.
- Add an independent kill switch, `deduplication.corroboration_enabled` (default
  `true`): `false` restores exactly today's top-1-only decision logic.
- Emit a structured `corroborated_dedup` warning log when the new path fires, so
  operators can see how often it triggers and a future consolidation job has a signal
  to mine.
- Document the widened window, the new config keys, and the corroboration path in
  `README.md` (mermaid diagram, Phase 2 table, config reference, the `:818`
  provenance note) and the four translations; bump `package.json`.

## Capabilities

### New Capabilities

- `dedup-candidate-window`: the write pipeline's dedup classifier SHALL evaluate a
  configurable window of the fetched similarity candidates, not only the closest one,
  and SHALL classify `UPDATE` for a corroborated near-duplicate cluster even when no
  single candidate independently clears the tier's UPDATE threshold.

### Modified Capabilities

(none — this adds a new decision path without altering the existing NOOP/DELETE/
single-candidate-UPDATE/ADD requirements defined in `bootstrap-memory-core`'s
`write-decision-pipeline` or `fix-dedup-noop-and-collection-delete-consistency`'s
`write-dedup-noop-correctness`.)

## Impact

- Affected code: `src/pipeline/index.ts` (`classifyOperation`), `src/config/index.ts`
  (`deduplication` schema), `src/pipeline/index.test.ts`.
- Affected behavior: some writes that previously classified `ADD` — because the single
  closest match fell just under the UPDATE threshold even though several
  near-identical memories already existed — now classify `UPDATE` into the strongest of
  those candidates. `NOOP`/`DELETE`/exact-checksum/vectorless-fallback behavior is
  unchanged. `corroboration_enabled: true` is a safe default given the narrow default
  margin/count; the kill switch covers operators who want strict top-1 semantics.
- No new I/O: reuses the top-10 `searchSimilar` result already fetched at
  `src/pipeline/index.ts:136-141`. This proposal does not depend on
  `fix-qdrant-client-search-removal` landing first (it is already merged in the current
  branch history) but does depend on its effect — that fix is what makes the 10-item
  window a trustworthy signal to widen into, rather than a possibly-silently-degraded
  empty result.
- Precursor/complement to `add-duplicate-cluster-consolidation` (unbuilt — the
  brainstorm's item 5.1, an offline job that clusters *existing* near-duplicate vectors
  and produces a human-approved merge report): better online targeting at write time
  reduces the rate at which near-duplicate clusters accumulate going forward, but does
  nothing for duplicates already sitting in the store. Consolidation still has
  historic accretion to clean up regardless of whether this proposal lands. This
  proposal is fully buildable and independently valuable — it has no dependency on
  consolidation existing.
- Docs: `README.md` (mermaid diagram, Phase 2 table + text, config reference,
  embedding-migration note), four translations, `package.json` version bump.
