## ADDED Requirements

### Requirement: Namespace values are safely encodable as Qdrant collection names
Any `namespace` value accepted by the public schema pattern (`^[a-zA-Z0-9/-]{1,200}$`) SHALL be resolvable to a valid Qdrant collection name without error, including values containing `/`.

#### Scenario: Slash-containing namespace succeeds on write
- **WHEN** a client calls `remember` with `namespace: "test/mcp-verify"`
- **THEN** the memory is stored successfully
- **AND** no `INTERNAL` error is returned

#### Scenario: Slash-containing namespace succeeds on read
- **WHEN** a client calls `recall` or `search` with a namespace containing `/`
- **THEN** results are returned from that namespace exactly as they would be for a namespace without `/`

### Requirement: Namespace-to-collection-name encoding is collision-free
The encoding used to embed a namespace in a Qdrant collection name SHALL be injective across the full valid namespace input space, and SHALL NOT allow one namespace's encoded prefix to false-positive match a different namespace's collections during namespace-wide (omitted-`collection`) lookups.

#### Scenario: Distinct namespaces never share a collection name
- **WHEN** two different valid namespace values are each used to store a memory in the same `collection`
- **THEN** the two memories are stored in two distinct Qdrant collections

#### Scenario: A namespace is not a false prefix match for a longer, related namespace
- **WHEN** namespace `"a"` and namespace `"a/b"` both have memories stored
- **AND** a client performs an omitted-`collection` search scoped to namespace `"a"`
- **THEN** the search does not include memories belonging to namespace `"a/b"`

### Requirement: Collection-name-shaped failures surface as actionable errors
If a namespace/collection pair still cannot be turned into a valid Qdrant collection name, or Qdrant rejects the resulting name, the system SHALL return `INVALID_INPUT` or `CONFLICT` rather than a generic `INTERNAL` error.

#### Scenario: A collection-name rejection is not reported as INTERNAL
- **WHEN** a Qdrant operation fails specifically because of the resolved collection name
- **THEN** the MCP error returned to the caller has code `INVALID_INPUT` or `CONFLICT`
- **AND** the error is not marked `retryable: true` as a bare `INTERNAL` failure would be
