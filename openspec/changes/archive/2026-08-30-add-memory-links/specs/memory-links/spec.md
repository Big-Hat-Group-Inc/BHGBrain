## ADDED Requirements

### Requirement: Memories SHALL be connectable by typed, directed edges
A client SHALL be able to create a directed edge between two memories, each edge typed
as one of `refines`, `contradicts`, `derived_from`, `about_same_entity`, or `follows`.

#### Scenario: Creating an edge
- **WHEN** a client adds an edge between two existing memories in the same namespace
  with a supported relation
- **THEN** the edge SHALL be persisted and returned

#### Scenario: Re-adding an existing edge is idempotent
- **WHEN** a client adds an edge identical to one that already exists (same source,
  target, and relation)
- **THEN** the existing edge SHALL be returned unchanged rather than duplicated or
  rejected

#### Scenario: Self-links are rejected
- **WHEN** a client attempts to add an edge from a memory to itself
- **THEN** the request SHALL fail with an invalid-input error

#### Scenario: Cross-namespace links are rejected
- **WHEN** a client attempts to add an edge between two memories in different
  namespaces
- **THEN** the request SHALL fail with an invalid-input error

#### Scenario: Adding an edge to a missing memory
- **WHEN** a client adds an edge where either memory id does not exist
- **THEN** the request SHALL fail with a not-found error

### Requirement: A memory's edges SHALL be listable and removable
A client SHALL be able to list all edges touching a given memory, in either direction,
optionally filtered by relation, and remove a specific edge.

#### Scenario: Listing edges in both directions
- **WHEN** a client lists edges for a memory that is the source of one edge and the
  target of another
- **THEN** both edges SHALL be returned, each marked with its direction relative to the
  requested memory

#### Scenario: Filtering by relation
- **WHEN** a client lists edges for a memory with a relation filter
- **THEN** only edges of that relation SHALL be returned

#### Scenario: Removing an edge
- **WHEN** a client removes an edge that exists
- **THEN** the edge SHALL no longer be returned by subsequent listings

#### Scenario: Removing a non-existent edge
- **WHEN** a client removes an edge that does not exist
- **THEN** the request SHALL fail with a not-found error

### Requirement: Deleting a memory SHALL cascade-delete its edges
Removing a memory from active storage, whether by direct deletion or by archival,
SHALL remove every edge that referenced it, so no edge persists pointing at a memory
that no longer exists.

#### Scenario: Forgetting a linked memory
- **WHEN** a memory that participates in one or more edges is deleted
- **THEN** all edges referencing it SHALL be removed

#### Scenario: Archiving a linked memory
- **WHEN** a memory that participates in one or more edges is archived
- **THEN** all edges referencing it SHALL be removed, the same as direct deletion

### Requirement: Recall SHALL optionally expand results to one-hop linked neighbors
`recall` SHALL support an opt-in parameter that, when set, appends each result's
directly linked memories to the response, distinguishing them from directly relevant
results.

#### Scenario: Default behavior is unchanged
- **WHEN** a recall does not request link expansion
- **THEN** the response SHALL contain only directly relevant results, with no linked
  memories appended

#### Scenario: Expansion appends one-hop neighbors
- **WHEN** a recall requests link expansion
- **THEN** each returned memory's directly linked memories SHALL be appended to the
  response
- **AND** each appended memory SHALL be marked with the id of the memory it was
  reached from, the relation, and the direction of the edge

#### Scenario: Expansion does not traverse beyond one hop
- **WHEN** a recall requests link expansion
- **THEN** memories reachable only through a linked memory's own links (two or more
  hops away) SHALL NOT be appended

#### Scenario: Expansion is bounded and deduplicated
- **WHEN** a recall requests link expansion and the same neighbor is reachable from
  multiple results, or many neighbors exist
- **THEN** each distinct neighbor SHALL appear at most once
- **AND** the number of appended neighbors SHALL be bounded rather than unbounded
