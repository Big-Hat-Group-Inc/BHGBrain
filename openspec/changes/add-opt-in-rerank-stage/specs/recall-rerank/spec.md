## ADDED Requirements

### Requirement: Recall SHALL support an opt-in LLM rerank stage over its candidate pool
`recall` SHALL support a configuration-gated stage that re-scores its retrieved
candidate pool by sending the query and each candidate's text to a configured LLM,
which returns a relevance judgment in `[0, 1]` per candidate, before `min_score`
filtering and truncation to `limit`.

#### Scenario: Reranking is disabled by default
- **WHEN** a `recall` call is made with no `search.rerank` configuration set
- **THEN** the rerank stage SHALL NOT run
- **AND** no additional network call SHALL be made beyond the existing embedding and
  store calls
- **AND** result ordering, membership, and content SHALL be identical to `recall`'s
  behavior before this capability existed

#### Scenario: Reranking is enabled and succeeds
- **WHEN** `search.rerank.enabled` is `true` and a valid API key is configured
- **AND** a `recall` call retrieves a candidate pool
- **THEN** the top `search.rerank.candidate_pool` candidates (by pre-rerank score)
  SHALL be scored by the configured rerank provider
- **AND** each successfully-scored candidate's `score` SHALL be replaced with its
  clamped rerank score, and its `rerank_score` field SHALL be populated
- **AND** the candidate list SHALL be re-sorted by `score` descending before
  `min_score` filtering and truncation to `limit` are applied

#### Scenario: Rerank provider fails or times out
- **WHEN** reranking is enabled
- **AND** the rerank provider call errors, times out, or returns a response that
  fails validation
- **THEN** `recall` SHALL NOT fail because of it
- **AND** the candidate list SHALL fall back to its pre-rerank order
- **AND** the failure SHALL be observable via a `search_rerank_degraded` counter
  increment and a structured warning log

#### Scenario: Partial rerank response
- **WHEN** reranking is enabled
- **AND** the rerank provider returns valid scores for only some of the requested
  candidates
- **THEN** scored candidates SHALL use their new rerank score
- **AND** unscored candidates SHALL retain their pre-rerank score and SHALL NOT be
  dropped from the result set

### Requirement: Reranking SHALL NOT alter `min_score` filtering or result membership rules
The `min_score` threshold SHALL continue to apply to `semantic_score`, exactly as
before this capability existed, regardless of whether reranking ran or how it scored
any candidate.

#### Scenario: Threshold-filtered recall with reranking enabled
- **WHEN** `search.rerank.enabled` is `true`
- **AND** a `recall` call applies `min_score`
- **THEN** result membership SHALL be identical to membership computed with
  reranking disabled, given the same underlying candidates and the same
  `semantic_score` values

### Requirement: Rerank configuration SHALL be independent of the pipeline extraction hook
The rerank stage's model and API key resolution SHALL be governed exclusively by its
own `search.rerank.*` configuration fields and SHALL NOT read or depend on
`pipeline.extraction_model`, `pipeline.extraction_model_env`, or
`pipeline.extraction_enabled`.

#### Scenario: Rerank works regardless of extraction pipeline state
- **WHEN** `pipeline.extraction_enabled` is `false` (or the extraction hook remains
  unimplemented, as it is at the time this capability is added)
- **AND** `search.rerank.enabled` is `true` with a valid `search.rerank.model_env`
  key configured
- **THEN** the rerank stage SHALL function normally, using only `search.rerank.*`
  configuration

### Requirement: Reranking SHALL be scoped to `recall` and SHALL NOT affect `search` or `memory://inject`
The rerank stage SHALL only run as part of the `recall` tool's flow. The `search`
tool and the `memory://inject` / `memory://inject/{hint}` resources SHALL be
unaffected by `search.rerank` configuration.

#### Scenario: Search tool is unaffected by rerank configuration
- **WHEN** `search.rerank.enabled` is `true`
- **AND** a `search` tool call is made
- **THEN** its results, ordering, and latency profile SHALL be unaffected by the
  rerank stage

#### Scenario: memory://inject is unaffected by rerank configuration
- **WHEN** `search.rerank.enabled` is `true`
- **AND** `memory://inject` or `memory://inject/{hint}` is read
- **THEN** the injected content SHALL be unaffected by the rerank stage
