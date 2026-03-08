## ADDED Requirements

### Requirement: Resource URIs SHALL expose memory and taxonomy views
The server SHALL provide resource handlers for `memory://list`, `memory://{id}`, `category://list`, `category://{name}`, `collection://list`, `collection://{name}`, and `health://status`.

#### Scenario: Memory list returns newest-first pagination
- **WHEN** a client reads `memory://list`
- **THEN** the response is cursor-paginated and ordered newest first

#### Scenario: Memory by id returns full details
- **WHEN** a client reads `memory://{id}` for an existing memory
- **THEN** the response includes full stored memory details

### Requirement: Resource reads SHALL enforce namespace visibility rules
Resource handlers SHALL respect namespace scoping defaults and SHALL not return cross-namespace data unless explicitly requested.

#### Scenario: Default resource read is namespace-scoped
- **WHEN** a client fetches resources without explicit cross-namespace parameters
- **THEN** only matching namespace data is returned

#### Scenario: Explicit namespace parameter selects target namespace
- **WHEN** a client provides a namespace query parameter on supported resources
- **THEN** results are filtered to that exact namespace
