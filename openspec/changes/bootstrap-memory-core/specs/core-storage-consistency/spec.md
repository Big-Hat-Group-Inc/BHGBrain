## ADDED Requirements

### Requirement: Memory writes SHALL be namespace-scoped by default
The system SHALL scope write, read, deduplication, and similarity retrieval operations to the request namespace. There is no explicit cross-namespace query mode in v1: every write, read, deduplication, and similarity retrieval path is namespace-scoped unconditionally.

#### Scenario: Default retrieval excludes other namespaces
- **WHEN** a query is executed
- **THEN** results include only memories in the specified or default namespace

### Non-Goal: Explicit cross-namespace query mode

De-scoped for v1 (audit follow-up 4.6, `codeaudit/bootstrap-memory-core-2026-06-05-02-19.md`).
No code path accepts a cross-namespace flag today — `QdrantStore.searchSimilar`,
`QdrantStore.search`, and every SQLite read helper filter to a single namespace with
no override. Introducing a real cross-namespace mode touches the write pipeline,
search API, MCP tool schemas, and resource handlers simultaneously and risks a
namespace-isolation regression if rushed, so it is deferred to a dedicated follow-up
change rather than bolted on here. Until that change lands, namespace scoping is
always-on and non-optional.

### Requirement: SQLite and Qdrant persistence SHALL remain logically consistent
The system SHALL persist memory metadata and vector records with matching IDs and namespace/collection metadata, and SHALL not report successful writes unless required records are committed.

#### Scenario: Successful write stores both metadata and vector entries
- **WHEN** a memory write operation completes successfully
- **THEN** both SQLite and Qdrant contain matching records for the memory id

#### Scenario: Partial write failure does not return success
- **WHEN** one store write succeeds and the other fails
- **THEN** the operation returns an error and triggers configured rollback or compensation handling

### Requirement: Embedding space compatibility SHALL be enforced per collection
The system SHALL reject writes that would mix incompatible embedding provider/model dimensions within the same collection.

#### Scenario: Matching embedding configuration allows writes
- **WHEN** collection embedding metadata matches the active provider/model dimensions
- **THEN** write processing continues

#### Scenario: Mismatched embedding configuration is blocked
- **WHEN** a write targets a collection with incompatible embedding space metadata
- **THEN** the system rejects the write with an embedding compatibility error
