## ADDED Requirements

### Requirement: Search hydration must avoid N+1 SQLite lookups
Search result assembly SHALL use bulk memory retrieval rather than one SQLite lookup per result ID.

#### Scenario: Hybrid search returns ranked IDs
- **WHEN** the search layer receives a ranked list of memory IDs
- **THEN** it hydrates the corresponding memories through a bounded number of SQLite queries
- **THEN** the final response preserves the original ranking order

### Requirement: Read-path access recording must remain bounded
Read traffic SHALL NOT create unbounded write amplification from per-result metadata persistence.

#### Scenario: Frequent search traffic
- **WHEN** many search requests return multiple results
- **THEN** access metadata persistence remains bounded by batching, sampling, or equivalent policy
- **THEN** request latency does not scale linearly with full-database persistence work
