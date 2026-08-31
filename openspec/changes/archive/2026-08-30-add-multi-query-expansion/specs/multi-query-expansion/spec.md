## ADDED Requirements

### Requirement: Semantic search SHALL search more than one representation of a query
`semanticSearch` and the semantic leg of `hybridSearch` SHALL, when
`search.query_expansion.enabled` is true, embed and search the original query plus a
deterministic keyword-stripped variant (when it differs from the original and is
non-empty), unioning candidates by memory id before scoring continues.

#### Scenario: Keyword-stripped variant surfaces a memory the literal query misses
- **WHEN** a query contains stopwords that dilute its embedding (e.g. "how do we
  deploy")
- **AND** a memory is a strong semantic match for the keyword-stripped variant
  ("deploy") but not for the literal query
- **THEN** that memory SHALL appear among the candidates considered for the result set

#### Scenario: Degenerate keyword variant is skipped
- **WHEN** the query is entirely stopwords, or stripping stopwords leaves it identical
  to the original
- **THEN** only the original query SHALL be searched

### Requirement: Candidates from multiple variants SHALL be merged by id, keeping the max score
When the same memory id is returned by more than one query variant, its score in the
merged candidate set SHALL be the maximum score across those variants, not a sum or
average.

#### Scenario: A memory matched by two variants is not double-counted
- **WHEN** a memory id appears in both the original query's results and the
  keyword-stripped variant's results with different scores
- **THEN** the merged candidate SHALL carry the higher of the two scores

### Requirement: Query expansion SHALL NOT change the per-call result-count bound
After merging candidates across variants, the candidate set SHALL be truncated to the
caller's requested `limit` before scoring, ranking, and expiry filtering proceed, so
enabling query expansion does not change how many results a `search()` call can return.

#### Scenario: Expansion widens membership, not count
- **WHEN** query expansion is enabled and produces more distinct candidate ids across
  variants than `limit`
- **THEN** the number of results returned SHALL still be bounded by `limit`, identical
  to the bound with expansion disabled

### Requirement: min_score and composite ranking SHALL apply unchanged to expanded results
Query expansion SHALL NOT alter how `min_score` is applied or how composite ranking
computes its prior; both SHALL continue to read the same score fields as before this
change, now populated from the wider candidate pool.

#### Scenario: Threshold filtering is unaffected by expansion
- **WHEN** a recall applies `min_score`
- **THEN** membership SHALL be determined by the same `semantic_score` comparison as
  before query expansion existed, evaluated against the merged (max) score

### Requirement: Fulltext-only search and hybrid's fulltext leg SHALL NOT be expanded
Query expansion SHALL apply only to the embedding-based (semantic) candidate
generation. Standalone fulltext-mode search and the fulltext leg within hybrid search
SHALL continue to search the single original query string.

#### Scenario: Hybrid search's fulltext leg is unexpanded
- **WHEN** a hybrid search runs with query expansion enabled
- **THEN** the fulltext leg SHALL be queried exactly once, with the original query
  string, regardless of how many semantic-leg variants were searched

### Requirement: LLM-generated paraphrase/HyDE variants SHALL be opt-in and key-gated
LLM-backed variant generation SHALL only run when
`search.query_expansion.llm_paraphrase.enabled` is true AND an API key resolves from
`pipeline.extraction_model_env` (falling back to `OPENAI_API_KEY`). Any failure to
generate LLM variants SHALL degrade silently to the variants already produced without
a model, never failing the search call.

#### Scenario: LLM paraphrase disabled by default
- **WHEN** `search.query_expansion.llm_paraphrase.enabled` is left at its default
- **THEN** no chat-completion call SHALL be made and only the no-model variants SHALL
  be searched

#### Scenario: Enabled but no key resolves
- **WHEN** `llm_paraphrase.enabled` is true
- **AND** neither the configured `extraction_model_env` variable nor `OPENAI_API_KEY`
  is set
- **THEN** the search SHALL proceed using only the no-model variants, with no error
  surfaced to the caller

#### Scenario: LLM call fails or times out
- **WHEN** `llm_paraphrase.enabled` is true and a key resolves
- **AND** the chat-completion call errors, returns a non-2xx response, or exceeds
  `timeout_ms`
- **THEN** the search SHALL proceed using only the variants already available (original
  plus keyword-stripped, if applicable) rather than failing or blocking

### Requirement: Total variant count SHALL be bounded by max_variants
The combined count of the original query, the keyword-stripped variant, and any
LLM-generated variants SHALL NOT exceed `search.query_expansion.max_variants`; variants
beyond the cap SHALL be dropped, not queued.

#### Scenario: LLM variants exceed the cap
- **WHEN** LLM generation returns more paraphrases than `max_variants` allows for after
  the original and keyword variants are counted
- **THEN** only enough LLM variants to reach `max_variants` SHALL be searched, and the
  rest SHALL be discarded
