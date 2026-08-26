## ADDED Requirements

### Requirement: The vector-store adapter SHALL only call client methods its dependency range guarantees
The declared version range for the Qdrant client dependency SHALL NOT span a version in which a
method the adapter calls has been removed. The adapter SHALL target the client API supported
across the entire declared range.

#### Scenario: A fresh install resolves a client that supports every method the adapter calls
- **WHEN** the project is installed from `package.json` with no lockfile and the highest permitted
  client version is resolved
- **THEN** every Qdrant client method invoked by the storage adapter exists on the resolved client
- **AND** semantic retrieval completes without a missing-method error

#### Scenario: Read path works on both ends of the declared range
- **WHEN** the adapter is exercised against the lowest and the highest client version permitted by
  the declared range
- **THEN** semantic search returns mapped results in both cases
- **AND** neither case depends on a client method absent from the other

### Requirement: Vector-store call failures SHALL NOT be reported as empty results
Similarity and search operations SHALL distinguish a genuine empty result set from a failed call.
A transport error, authentication error, or missing client method SHALL surface as a failure or an
explicit degraded signal, and SHALL NOT be returned to callers as "no matches".

#### Scenario: Similarity check failure does not present as no-duplicates
- **WHEN** the write pipeline requests a near-duplicate similarity check
- **AND** the vector store call fails for any reason other than reporting zero matches
- **THEN** the pipeline receives a failure or an explicit degraded-similarity signal
- **AND** the write is not silently recorded as novel on the basis of an empty result

#### Scenario: A genuinely empty result set is still empty
- **WHEN** the vector store successfully returns zero matching vectors
- **THEN** the caller receives an empty result set
- **AND** no failure or degraded signal is raised

### Requirement: Result mapping SHALL be verified against the client response shape
Adapter tests SHALL assert that successful retrieval produces non-empty mapped results from a
representative client response, so a response-shape mismatch fails as a test failure rather than
degrading to empty output.

#### Scenario: A response-shape mismatch fails the suite
- **WHEN** the client returns a populated response in its documented shape
- **AND** the adapter fails to unwrap that shape correctly
- **THEN** the adapter test suite fails
- **AND** the defect is not observable only as an empty result set at runtime

### Requirement: Client test doubles SHALL be bound to the real client type
Test doubles that replace the Qdrant client SHALL derive their type from the real client type
rather than declaring an independent structural shape, so removal of a method the adapter calls is
rejected by type checking.

#### Scenario: Upstream method removal fails type checking
- **WHEN** a future client version removes a method the adapter calls
- **AND** the project type check is run
- **THEN** type checking fails against the test double and the adapter call site
- **AND** the failure occurs without requiring a live vector store
