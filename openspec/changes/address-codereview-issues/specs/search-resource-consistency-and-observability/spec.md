## ADDED Requirements

### Requirement: Search and resources honor collection scoping consistently
Fulltext and hybrid search SHALL respect caller-provided collection scope in both semantic and lexical candidate sets.

#### Scenario: Collection-scoped fulltext search
- **WHEN** caller supplies namespace and collection
- **THEN** fulltext results include only memories from that collection

### Requirement: Pagination cursors are stable and non-lossy
Paginated memory listing SHALL use deterministic ordering with a stable tie-breaker cursor.

#### Scenario: Multiple rows share same creation timestamp
- **WHEN** client paginates across timestamp ties
- **THEN** no records are skipped or duplicated across pages

### Requirement: Dependency failures are surfaced explicitly
Semantic search dependency failures SHALL not be silently converted into empty success results.

#### Scenario: Qdrant outage during semantic query
- **WHEN** vector search dependency fails
- **THEN** caller receives explicit degraded/dependency error signal

### Requirement: Metrics and file persistence are bounded and safe
Metrics aggregation and storage writes SHALL avoid unbounded memory growth and non-atomic overwrite risks.

#### Scenario: Long-running process with continuous traffic
- **WHEN** metrics are recorded for extended duration
- **THEN** in-memory metrics storage remains bounded

#### Scenario: Database or backup file write
- **WHEN** persistence write occurs
- **THEN** data is written using atomic replace semantics to avoid truncated partial files
