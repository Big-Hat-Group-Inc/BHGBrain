## 1. Config schema

- [x] 1.1 Add four fields to the `deduplication` object in `src/config/index.ts`
  (currently `src/config/index.ts:146-149`): `candidate_window`
  (`z.number().int().min(1).max(10).default(5)` — capped at 10 because
  `searchSimilar` is called with a hardcoded `topK=10` at
  `src/pipeline/index.ts:140`), `corroboration_enabled`
  (`z.boolean().default(true)`), `corroboration_count`
  (`z.number().int().min(2).default(2)`), `corroboration_margin`
  (`z.number().min(0).max(1).default(0.03)`).
- [x] 1.2 Add a doc comment above the block explaining the corroboration formula,
  mirroring the style of the `search.ranking` comment at `src/config/index.ts:162-165`.

## 2. Classifier logic

- [x] 2.1 In `classifyOperation` (`src/pipeline/index.ts:291-313`), slice `similar` to
  `this.config.deduplication.candidate_window` and use that slice (`window`) for the
  new corroboration check. Keep `top = window[0]` (equal to `similar[0]`) driving the
  existing DELETE/NOOP/direct-UPDATE branches exactly as today — no change to those
  three `if` blocks.
- [x] 2.2 After the existing three threshold checks and before the final
  `return { op: 'ADD' }`, add the corroboration branch: gated on
  `this.config.deduplication.corroboration_enabled`, count window members with
  `score >= thresholds.update - this.config.deduplication.corroboration_margin`; if
  that count is `>= this.config.deduplication.corroboration_count`, return
  `{ op: 'UPDATE', targetId: top.id }`.
- [x] 2.3 When the corroboration branch fires, call `this.logger?.warn({ event:
  'corroborated_dedup', targetId: top.id, topScore: top.score, corroborators: <count>
  })`, mirroring the existing `degraded_write` warn shape at
  `src/pipeline/index.ts:124-129`.
- [x] 2.4 Confirm by inspection that no changes are needed to the `decide()` call site
  (`src/pipeline/index.ts:82-143`, specifically the `searchSimilar`/`classifyOperation`
  calls at `:136-143`) or to `deterministicFallback`/`textSimilarity`
  (`:318-336`, `:337+`) — the vectorless fallback path has its own single-candidate FTS
  flow and is explicitly out of scope (see `design.md` Non-Goals).

## 3. Tests (`src/pipeline/index.test.ts`)

- [x] 3.1 Corroboration triggers UPDATE: mock `storage.qdrant.searchSimilar` to return
  3+ candidates each scoring within `corroboration_margin` of (but individually below)
  the tier's UPDATE threshold; assert the result is `UPDATE` targeting the
  highest-scoring candidate's id.
- [x] 3.2 Corroboration count not met: only 1 candidate qualifies within the margin;
  assert the result is still `ADD` (default `corroboration_count: 2` not reached).
- [x] 3.3 Kill-switch test: with `deduplication.corroboration_enabled: false` and the
  same 3+-candidate cluster from 3.1, assert the result is `ADD` (pre-widening
  behavior preserved).
- [x] 3.4 Window-size regression test: with `deduplication.candidate_window: 1` and the
  same 3+-candidate cluster, assert the result is `ADD` — confirms `candidate_window`
  bounds the evaluated set and that a window of 1 is behaviorally identical to the
  pre-change top-1-only classifier.
- [x] 3.5 Regression check: run the existing NOOP/UPDATE(direct)/DELETE/ADD
  single-candidate tests already in the file unmodified and confirm they still pass —
  no edits expected to those cases, since `top`/`window[0]` computation is unchanged.
- [x] 3.6 Logging assertions: `logger.warn` is called with a `corroborated_dedup`
  event when the branch fires (3.1) and is *not* called for a plain single-candidate
  `ADD`, `UPDATE`, `NOOP`, or `DELETE` decision — mirror the existing
  `degraded_write` assertion pattern at `src/pipeline/index.test.ts:110-141`.

## 4. Docs and validation

- [x] 4.1 `README.md`: update the Phase 2 mermaid diagram (`:1168-1204`, node `G`/`H`
  and the decision edges) and the surrounding Phase 2 text/table (`:1214-1236`) to
  describe window-based corroboration alongside the single-closest-candidate path;
  update the config reference block (`:393-400`) to document the four new
  `deduplication.*` keys; update the `similar[0]` phrase at `:818` (embedding-migration
  section) so it no longer implies only the closest candidate feeds dedup.
- [x] 4.2 Mirror the same changes into `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md` — CLAUDE.md requires a user-facing `README.md` change to land in
  all five translations or none.
- [x] 4.3 Bump `package.json` `version` (currently `1.11.0`) for the new config surface
  and behavior change.
- [x] 4.4 Run `npm run lint && npm test`; fix any fallout before considering the change
  complete.
