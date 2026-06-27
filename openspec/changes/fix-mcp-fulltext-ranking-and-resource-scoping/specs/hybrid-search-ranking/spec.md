## ADDED Requirements

### Requirement: Fulltext mode SHALL rank by real lexical relevance

Fulltext search SHALL assign each matching memory a per-row lexical relevance score derived from the actual match (e.g. SQLite FTS `bm25`/`rank`, or a deterministic term-frequency score when FTS5 is unavailable), and SHALL order results by that score. A query that matches multiple memories SHALL NOT assign them an identical constant rank.

#### Scenario: Distinct matches receive distinct relevance ranks

- **WHEN** `search` is called with mode `fulltext` and the query matches multiple memories with differing match strength
- **AND** one memory matches the query terms more strongly than another (e.g. more term occurrences or matches in more fields)
- **THEN** the more strongly matching memory ranks higher than the weaker match
- **AND** the returned ranks are not a single constant value shared by all rows

#### Scenario: Hybrid fulltext component reflects real relevance

- **WHEN** `search` is called with mode `hybrid`
- **THEN** the fulltext rank fed into Reciprocal Rank Fusion is derived from the lexical relevance score, not from SQL insertion order

### Requirement: Hybrid mode SHALL surface embedding outages instead of swallowing them

When the embedding provider is unavailable during a hybrid search, the system SHALL log the degradation and signal the partial (fulltext-only) result to the caller. It SHALL NOT silently degrade with no log, metric, or caller-visible signal.

#### Scenario: Embedding outage during hybrid search is observable

- **WHEN** `search` is called with mode `hybrid`
- **AND** the embedding provider raises an error while computing the query vector
- **THEN** the system emits a warning log indicating the search degraded to fulltext-only
- **AND** the response includes a signal that the result is degraded (fulltext-only)
- **AND** results are still returned from the fulltext component rather than failing the request
