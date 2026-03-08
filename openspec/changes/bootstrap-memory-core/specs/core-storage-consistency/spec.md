## ADDED Requirements

### Requirement: Memory writes SHALL be namespace-scoped by default
The system SHALL scope write, read, deduplication, and similarity retrieval operations to the request namespace unless an explicit cross-namespace mode is requested.

#### Scenario: Default retrieval excludes other namespaces
- **WHEN** a query is executed without cross-namespace mode
- **THEN** results include only memories in the specified or default namespace

#### Scenario: Explicit cross-namespace mode includes multiple namespaces
- **WHEN** a query is executed with explicit cross-namespace configuration
- **THEN** results may include memories from more than one namespace

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
