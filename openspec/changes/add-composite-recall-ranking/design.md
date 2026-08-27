## Context

Ranking today is single-signal. `SearchService.buildSearchResults`
(`src/search/index.ts:213`) receives ranked `(id, score)` pairs from the mode
implementations, hydrates rows, drops expired ones, applies the hybrid-only T0 +0.1,
and returns. All auxiliary signals are on the hydrated `MemoryRecord` already — no new
I/O is needed to rank with them; the rows are in hand at exactly the right moment.

## Goals / Non-Goals

Goals:
- Rank by relevance × prior, where the prior blends importance, access frequency, and
  tier-aware recency decay.
- Fully config-driven weights with defaults that are conservative but not inert.
- No change to `min_score` filtering semantics or to the raw score fields.

Non-Goals:
- No learned weights or feedback loop (a future `recall-feedback` change).
- No change to which candidates the stores return (that is filter push-down / FTS5).
- No re-ranking model calls.

## Decisions

- **Formula**: `final = relevance × prior`, with
  `prior = w_base + w_imp·importance + w_acc·log1p(access_count) / log1p(acc_norm)`
  multiplied by `exp(−λ_tier · age_days)`, `age = now − updated_at` (updated_at, not
  created_at, so a refreshed memory is "young" again — consistent with UPDATE
  semantics).
- **Defaults**: `w_base: 1.0`, `w_imp: 0.3`, `w_acc: 0.2`, `acc_norm: 50`,
  `λ = {T0: 0, T1: 0.002, T2: 0.008, T3: 0.02}` per day (T2 half-life ≈ 87 days,
  aligned with its 90-day TTL). A memory with default importance 0.5 and zero accesses
  gets prior ≈ 1.15 — ordering among same-aged memories then follows relevance, as now.
- **Multiplicative, not additive**: a multiplicative prior preserves relative relevance
  ordering within groups of equal prior and cannot resurrect an irrelevant result the
  way additive boosts (like the current +0.1) can; it also composes identically across
  score ranges (cosine vs RRF), which an additive constant does not.
- **Where applied**: in `buildSearchResults` for all three modes, replacing the
  `boostT0` option. Sorting must be re-done there after composite scoring (today the
  incoming order is trusted).
- **Config**: `search.ranking.{enabled, w_importance, w_access, access_norm,
  decay_per_day: {T0,T1,T2,T3}}` with `enabled: true` default; `enabled: false`
  restores pure-relevance ordering for operators who want the old behavior.

## Risks / Trade-offs

- Any ordering change can surprise existing users; mitigated by the `enabled` kill
  switch, conservative defaults, and README documentation.
- `access_count` is self-reinforcing (recalled memories get recalled more). The log
  damping and low default weight bound the feedback loop; a real fix is a feedback
  signal, out of scope here.
- Hybrid RRF scores are tiny (~0.03); multiplicative priors are safe there precisely
  because they are scale-free, but tests must cover both score ranges.
