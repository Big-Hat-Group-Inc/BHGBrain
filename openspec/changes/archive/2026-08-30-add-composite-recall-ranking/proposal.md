## Why

Every memory stores three ranking-relevant signals that the query path never reads:

- `importance` ([0,1], caller-supplied) is only used as `Math.max` during UPDATE
  merges (`src/pipeline/index.ts:176`) — it never influences which memory is returned.
- `access_count` drives tier promotion (`src/domain/lifecycle.ts:94`) but not ranking;
  a memory confirmed useful fifty times ranks identically to one never recalled.
- Recency is ignored entirely. An eight-month-old near-duplicate outranks last week's
  correction whenever its embedding is marginally closer.

The only prior signal in ranking today is a flat `+0.1` score boost for T0 memories in
hybrid mode (`src/search/index.ts:239-241`). The result: recall quality degrades as the
store ages, because relevance alone cannot distinguish current, trusted, frequently
used memories from stale look-alikes — exactly the memories a long-lived store
accumulates.

## What Changes

- Introduce a composite ranking score applied at result-assembly time
  (`buildSearchResults`):

  `final = relevance × (w_base + w_imp·importance + w_acc·log1p(access_count)) × exp(−λ_tier·age_days)`

  where `relevance` is the mode's existing score, weights and per-tier decay rates come
  from config, and T0's λ is 0 (never decays).
- Replace the flat T0 `+0.1` boost with the composite formula (T0 keeps an equivalent
  advantage via its zero decay and a configurable tier weight).
- Add a `search.ranking` config block (Zod schema + defaults) controlling the weights;
  defaults chosen so pure-relevance ordering changes only when the auxiliary signals
  meaningfully differ.
- Keep the raw component scores (`semantic_score`, `fulltext_score`) untouched on
  `SearchResult` and expose the pre-composite relevance so `min_score` semantics
  (cosine threshold) are unaffected.
- Document the ranking model in `README.md` + the four translations; bump version.

## Capabilities

### New Capabilities
- `composite-ranking`: Search and recall order results by a configurable composite of
  relevance, importance, access frequency, and tier-aware recency decay, instead of
  relevance alone.

### Modified Capabilities

## Impact

- Affected code: `src/search/index.ts` (`buildSearchResults`, hybrid boost removal),
  `src/config/index.ts` (new `search.ranking` schema), co-located tests.
- Behavior: result *ordering* changes when stored signals differ; result *membership*
  for threshold-filtered recalls is unchanged because `min_score` still applies to the
  cosine field.
- Docs: README ×5, `.env.example` unchanged, version bump.
- Depends on: nothing, but pairs naturally with `push-down-recall-filters` (which
  fixes what `min_score` applies to).
