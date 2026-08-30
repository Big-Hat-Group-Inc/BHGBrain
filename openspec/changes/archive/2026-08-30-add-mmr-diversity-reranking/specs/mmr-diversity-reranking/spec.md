## ADDED Requirements

### Requirement: Recall and search SHALL diversify their candidate pool via MMR reordering
`recall` and `search` (semantic and hybrid modes) SHALL reorder their composite-ranked
candidate pool by Maximal Marginal Relevance — trading a configurable amount of
top-ranked relevance for diversity — before downstream filtering and truncation, so a
returned top-K is not dominated by near-duplicate memories.

#### Scenario: Near-duplicate cluster present in the candidate pool
- **WHEN** the fetched candidate pool contains several near-duplicate, high-relevance
  memories and one distinct, slightly-lower-relevance memory
- **AND** `search.mmr.enabled` is `true`
- **THEN** the distinct memory SHALL be promoted ahead of at least one near-duplicate
  it would otherwise have been ranked below by relevance alone

#### Scenario: Fulltext-only search
- **WHEN** a `search` call uses `mode: 'fulltext'`
- **THEN** MMR reordering SHALL NOT apply, because fulltext candidates carry no
  vectors to diversify against

#### Scenario: Reordering never reduces the candidate pool
- **WHEN** MMR reordering runs over a candidate pool
- **THEN** every candidate present before reordering SHALL still be present afterward,
  in some order
- **AND** truncation to the caller's requested `limit`, `min_score` filtering, and
  type/tags filtering SHALL be applied only after reordering, unaffected in mechanism

### Requirement: MMR reranking SHALL be configurable and disableable
The diversity/relevance trade-off SHALL come from validated configuration
(`search.mmr.lambda`), and disabling the feature SHALL restore composite-relevance-only
ordering exactly.

#### Scenario: Operator disables MMR reranking
- **WHEN** `search.mmr.enabled` is `false`
- **THEN** `recall`/`search` ordering SHALL follow the composite ranking score alone,
  identical to behavior before this capability existed

#### Scenario: Lambda tunes the trade-off
- **WHEN** `search.mmr.lambda` is close to `1`
- **THEN** ordering SHALL closely approximate composite-relevance-only ordering
- **WHEN** `search.mmr.lambda` is close to `0`
- **THEN** ordering SHALL be dominated by pairwise dissimilarity among candidates

### Requirement: MMR reranking SHALL be scale-consistent across search modes
The relevance term used in the MMR trade-off SHALL be normalized per candidate pool so
that `lambda` has consistent meaning regardless of whether the pool's composite scores
come from cosine-scale semantic ranking or RRF-scale hybrid ranking.

#### Scenario: Hybrid-mode candidate pool
- **WHEN** a hybrid-mode candidate pool has composite scores far smaller in magnitude
  than pairwise cosine similarities
- **THEN** the diversity term SHALL NOT dominate the relevance term purely due to
  differing score scales

### Requirement: MMR reranking SHALL NOT affect memory://inject or its hint-driven suppression
The existing near-duplicate suppression behavior of `memory://inject/{hint}` SHALL be
unaffected by this capability.

#### Scenario: Hinted inject request
- **WHEN** a client reads `memory://inject/{hint}`
- **THEN** memory selection SHALL follow the same greedy threshold-based suppression
  that existed before this capability, unaffected by `search.mmr` configuration
