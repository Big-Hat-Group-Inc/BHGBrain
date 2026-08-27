## 1. Config schema

- [x] 1.1 Add `search.ranking` to the Zod config schema (`src/config/index.ts`):
  `enabled` (default true), `w_importance` (0.3), `w_access` (0.2), `access_norm`
  (50), `decay_per_day` per tier (`T0: 0, T1: 0.002, T2: 0.008, T3: 0.02`), all
  validated non-negative.
- [x] 1.2 Document the block in `.env.example`'s config-reference comment section only
  if applicable (no new env vars) and in `AGENTS.md` if config guidance changes.
  Neither applies: `.env.example` has no per-field config.json reference section
  (it documents secrets/overrides only, and `hybrid_weights` isn't listed there
  either), and `AGENTS.md`'s "Config vs. environment" section doesn't enumerate
  individual `search.*` fields. No new env vars were introduced. README.md +
  translations were updated instead (task 4.1).

## 2. Composite scoring

- [x] 2.1 Implement the composite prior in `buildSearchResults`
  (`src/search/index.ts`): `final = relevance × (w_base + w_imp·importance +
  w_acc·log1p(access_count)/log1p(access_norm)) × exp(−λ_tier·age_days)` with age from
  `updated_at`.
- [x] 2.2 Remove the hybrid-only `boostT0` +0.1 path; T0's advantage now comes from
  zero decay. Re-sort results after composite scoring.
- [x] 2.3 Preserve `semantic_score`/`fulltext_score` raw values on `SearchResult`;
  `min_score` filtering continues to use the cosine field.
- [x] 2.4 `enabled: false` bypasses the prior entirely (pure-relevance ordering,
  current behavior minus the removed +0.1).

## 3. Tests

- [x] 3.1 Ordering test: equal relevance, differing importance/access/age produce the
  expected composite order in both cosine-range and RRF-range score regimes.
- [x] 3.2 Decay test: T0 does not decay; T3 decays fastest; an UPDATE (fresh
  `updated_at`) resets a memory's age.
- [x] 3.3 Kill-switch test: `enabled: false` yields relevance-only ordering.
- [x] 3.4 Regression: min_score-filtered recall membership is unchanged by ranking
  config.

## 4. Docs

- [x] 4.1 Document the ranking model and config in `README.md` and the four
  translations; bump `package.json` version.
- [x] 4.2 `npm run lint` and `npm test` pass.
