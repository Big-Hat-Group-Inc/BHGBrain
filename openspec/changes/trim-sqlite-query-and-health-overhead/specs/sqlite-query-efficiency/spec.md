## ADDED Requirements

### Requirement: Hot list and sweep queries SHALL be served by covering indexes
Paginated memory listing, staleness sweeps, and vector-sync scans SHALL execute via
index search, without full-table scans and without temporary B-tree sorts for their
`ORDER BY` clauses. Index changes SHALL apply automatically to existing databases on
startup.

#### Scenario: Paginated listing uses an index-ordered plan
- **WHEN** `listMemories` or `listMemoriesInCollection` is explained via
  `EXPLAIN QUERY PLAN`
- **THEN** the plan SHALL show a search using a composite index whose leading columns
  match the predicate and whose trailing columns match `created_at, id`
- **AND** the plan SHALL NOT contain `USE TEMP B-TREE FOR ORDER BY`

#### Scenario: Staleness and vector-sync sweeps avoid full scans
- **WHEN** `listStaleCandidateIds` or `listMemoriesNeedingVectorSync` is explained
- **THEN** the plan SHALL show a search using an index covering the sweep predicate

#### Scenario: Existing database migrates on startup
- **WHEN** a database created before this change is opened
- **THEN** the new indexes SHALL exist after init
- **AND** the subsumed single-column indexes SHALL be removed

### Requirement: Batch mutations SHALL run in bounded transactions
Multi-row deletes and Qdrant hydration SHALL NOT execute one implicit transaction and
one existence probe per row.

#### Scenario: Batch delete
- **WHEN** `deleteMemories` removes N confirmed memories
- **THEN** the SQLite rows (memories and fulltext companions) SHALL be deleted via
  chunked `IN`-list statements inside a single transaction
- **AND** the returned deleted count SHALL equal the number of rows actually removed

#### Scenario: Hydration batches per collection but fails per point
- **WHEN** `bootstrapFromQdrant` hydrates a collection in which one point violates a
  constraint
- **THEN** every other point in that collection SHALL still be hydrated
- **AND** the failing point SHALL be logged and rolled back atomically (no orphan
  fulltext row)
- **AND** already-present points SHALL be skipped using a preloaded id set rather
  than a per-point lookup query

### Requirement: Fixed-SQL statements SHALL be prepared once per database handle
Queries whose SQL text is constant SHALL reuse a cached prepared statement, and cached
statements SHALL never outlive the database handle they were prepared on.

#### Scenario: Statement reuse
- **WHEN** the same fixed-SQL query runs repeatedly
- **THEN** the SQL SHALL be compiled at most once per database handle
- **AND** results SHALL be identical to an uncached execution

#### Scenario: Handle replacement invalidates the cache
- **WHEN** the store is closed or reloaded from disk
- **THEN** all cached statements SHALL be freed before the handle is replaced
- **AND** subsequent queries SHALL succeed against the new handle

### Requirement: A health poll SHALL compute each SQLite aggregate at most once
The health snapshot SHALL derive shared aggregates (tier counts, unsynced-vector
count) from a single computation per poll, and the stats block SHALL be served from a
short-TTL cache between polls.

#### Scenario: Single computation per snapshot
- **WHEN** one health check runs
- **THEN** `countByTier` and `countUnsyncedVectors` SHALL each execute at most once

#### Scenario: Poll storm within the TTL
- **WHEN** health checks repeat within the stats-cache TTL
- **THEN** the SQLite stats aggregates SHALL NOT be recomputed
- **AND** component statuses (degraded flags, lifecycle state) SHALL remain live and
  uncached

### Requirement: Summary derivation SHALL NOT allocate proportionally to content size
Generating a memory summary SHALL read only the first line of the content without
splitting the whole content into an array.

#### Scenario: Large multi-line content
- **WHEN** a summary is generated for content of any size
- **THEN** the output SHALL be byte-identical to the previous first-line/ellipsis
  behavior
- **AND** no per-line array of the full content SHALL be allocated
