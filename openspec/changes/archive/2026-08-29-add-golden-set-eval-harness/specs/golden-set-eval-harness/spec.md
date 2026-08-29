## ADDED Requirements

### Requirement: A seeded golden-set fixture SHALL exist for retrieval evaluation
The repository SHALL include a fixture corpus of memories and a golden set of at least
50 `(query, expected memory id)` pairs, where the corpus contains distractor memories
beyond the golden-set targets so recall@k is not trivially satisfied by corpus size
alone.

#### Scenario: Golden set references seeded corpus memories
- **WHEN** the golden-set fixture is loaded
- **THEN** every `expected memory id` it references SHALL exist in the seeded corpus
- **AND** the corpus SHALL contain more memories than the golden set has entries

### Requirement: The harness SHALL evaluate real production retrieval code
The harness SHALL seed a real `SqliteStore` and a real `QdrantStore` (backed by an
in-memory fake `QdrantClient` performing genuine similarity ranking, not canned
results) and run golden-set queries through the production `SearchService.search`
method, with no reimplementation of ranking, fusion, or filtering logic inside the
harness itself.

#### Scenario: Filter push-down is exercised through the real store
- **WHEN** a golden-set query specifies a `type` or `tags` filter
- **THEN** the harness SHALL pass it as a `RecallFilter` to `SearchService.search`
- **AND** the filter SHALL be applied by the real `QdrantStore`/`SqliteStore` filtering
  logic, not pre-filtered by the harness before scoring

#### Scenario: No network calls during evaluation
- **WHEN** the harness runs
- **THEN** it SHALL NOT make any outbound network call (no real OpenAI/Azure API, no
  real Qdrant server) and SHALL produce identical metrics across repeated runs with no
  corpus or fixture changes

### Requirement: The harness SHALL compute recall@k and MRR
For each golden-set query, the harness SHALL determine the rank (if any, within the top
10 results) of the expected memory id and SHALL compute, per query and in aggregate:
recall@1, recall@5, recall@10, and MRR@10 (reciprocal rank capped at 10, else 0).

#### Scenario: Expected memory found within top-k
- **WHEN** the expected memory id appears at rank `r` (1-indexed) in a query's results
- **AND** `r <= k`
- **THEN** that query SHALL score 1 for recall@k
- **AND** that query's reciprocal-rank contribution to MRR@10 SHALL be `1/r`

#### Scenario: Expected memory absent from top 10
- **WHEN** the expected memory id does not appear in the top 10 results for a query
- **THEN** that query SHALL score 0 for recall@1, recall@5, and recall@10
- **AND** that query's contribution to MRR@10 SHALL be 0

### Requirement: CI SHALL fail on a retrieval regression below checked-in floors
A Vitest spec SHALL run the harness and assert that aggregate recall@5 and MRR@10 meet
or exceed checked-in threshold constants, so `npm test` (already run in CI) fails when
a change regresses retrieval quality below the floor.

#### Scenario: Aggregate metric falls below its floor
- **WHEN** the harness's aggregate recall@5 or MRR@10 is below its checked-in floor
  constant
- **THEN** the Vitest spec SHALL fail

#### Scenario: Aggregate metrics meet floors
- **WHEN** the harness's aggregate recall@5 and MRR@10 are at or above their floor
  constants
- **THEN** the Vitest spec SHALL pass and `npm test` SHALL NOT report the eval spec as a
  failure

### Requirement: A standalone report command SHALL be available for local iteration
An `npm run eval` script SHALL run the same harness core used by the Vitest spec and
print a per-query and aggregate report to stdout, without requiring the full test suite
to run.

#### Scenario: Developer runs the eval script locally
- **WHEN** a developer runs `npm run eval`
- **THEN** the command SHALL seed the fixture store, run every golden-set query, and
  print each query's rank/hit-or-miss plus the aggregate recall@1/@5/@10 and MRR@10
- **AND** it SHALL exit non-zero if any query errors, independent of whether metrics
  meet their floors
