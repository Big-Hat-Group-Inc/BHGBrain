## ADDED Requirements

### Requirement: Search SHALL record a result-count distribution per mode
Every `SearchService.search()` call SHALL record the number of mode-specific results
returned to a `search_result_count` histogram labeled with the search mode
(`semantic`, `fulltext`, or `hybrid`), independent of whether archived matches are
additionally appended for that call.

#### Scenario: Semantic search records its result count
- **WHEN** a `semantic`-mode search returns 3 results
- **THEN** `search_result_count{mode="semantic"}` SHALL receive a sample of `3`

#### Scenario: Zero-result search is still recorded
- **WHEN** a search of any mode returns 0 results
- **THEN** `search_result_count` SHALL receive a sample of `0` for that mode, rather
  than recording nothing

#### Scenario: Archived matches do not inflate the count
- **WHEN** a search is called with `include_archived: true` and archived matches exist
- **THEN** the recorded `search_result_count` sample SHALL reflect only the
  mode-specific (non-archived) results

### Requirement: Search SHALL record a result-score distribution per mode
Every result returned by `SearchService.search()` SHALL contribute its composite score
to a `search_result_score` histogram labeled with the search mode, excluding archived
matches, which carry a placeholder score rather than a relevance score.

#### Scenario: Result scores are recorded per mode
- **WHEN** a `hybrid`-mode search returns results with composite scores `[0.8, 0.5]`
- **THEN** `search_result_score{mode="hybrid"}` SHALL receive samples `0.8` and `0.5`

#### Scenario: Archived matches are excluded from the score distribution
- **WHEN** a search appends archived matches (which carry a placeholder score, not a
  relevance score)
- **THEN** those archived matches' scores SHALL NOT be recorded to
  `search_result_score`

### Requirement: Degraded hybrid fallback SHALL be observable per namespace
When hybrid search degrades to fulltext-only because the embedding provider or vector
store is unavailable, the existing degraded-fallback counter SHALL be incremented with
a label identifying the namespace the degraded search occurred in.

#### Scenario: Degraded fallback is attributed to its namespace
- **WHEN** a hybrid search in namespace `"team-a"` degrades to fulltext-only
- **THEN** `search_embedding_degraded{namespace="team-a"}` SHALL be incremented by 1

#### Scenario: Degraded events in different namespaces accumulate independently
- **WHEN** namespace `"team-a"` experiences one degraded hybrid search
- **AND** namespace `"team-b"` experiences one degraded hybrid search
- **THEN** `search_embedding_degraded{namespace="team-a"}` and
  `search_embedding_degraded{namespace="team-b"}` SHALL each read `1`, independently

### Requirement: Counters SHALL support an optional label set
`MetricsCollector.incCounter` SHALL accept an optional labels argument and store/emit
counter values keyed by name and label set, consistent with how `recordHistogram`
already keys histogram families, so that labeled counters (such as the per-namespace
degraded counter) accumulate independently per label set and render with their labels
in `/metrics` output.

#### Scenario: Labeled counter calls accumulate per label set
- **WHEN** `incCounter('x', 1, { a: '1' })` is called twice
- **AND** `incCounter('x', 1, { a: '2' })` is called once
- **THEN** `getMetrics()` SHALL report `x{a="1"}` as `2` and `x{a="2"}` as `1`,
  as independent entries

#### Scenario: Unlabeled counter calls are unaffected
- **WHEN** `incCounter('y')` is called without a labels argument, as every pre-existing
  call site does
- **THEN** behavior SHALL be identical to before labels were supported: a single
  unlabeled series accumulates exactly as it did previously
