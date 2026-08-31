## ADDED Requirements

### Requirement: Memory records SHALL follow a canonical schema
The system SHALL persist each memory with a canonical record shape including identifiers, namespace/collection, type, content, summary, tags, source, checksum, embedding metadata, operation metadata, and timestamps as defined by the v1 schema.

#### Scenario: Valid memory creation persists canonical fields
- **WHEN** a client submits a valid memory write request
- **THEN** the stored memory includes all required canonical fields with valid types and constraints

#### Scenario: Invalid canonical fields are rejected
- **WHEN** a client submits a memory write with missing required fields or out-of-range values
- **THEN** the system rejects the write with a validation error and no memory is persisted

### Requirement: Memory type semantics SHALL be constrained
The system SHALL only accept `episodic`, `semantic`, or `procedural` as memory types and SHALL persist the resolved type on every stored memory.

#### Scenario: Accepted type is preserved on write
- **WHEN** a memory is submitted with an allowed type value
- **THEN** the stored memory type matches the accepted value

#### Scenario: Unknown type is rejected
- **WHEN** a memory is submitted with a type outside the allowed set
- **THEN** the request fails validation and returns an error

### Requirement: Category memories SHALL support persistent policy slots
The system SHALL support category memories for persistent policy context, including `company-values`, `architecture`, `coding-requirements`, and `custom` slots.

#### Scenario: Category entry is versioned on update
- **WHEN** category content is updated
- **THEN** the system increments the category revision and records updated timestamp

#### Scenario: Category entries are marked non-decaying
- **WHEN** retention processing evaluates stale memories
- **THEN** category entries are excluded from decay and consolidation deletion paths

### Requirement: Namespace and collection defaults SHALL be applied consistently
The system SHALL default namespace to `global` and collection to `general` when omitted and SHALL persist explicit values when provided.

#### Scenario: Omitted namespace and collection use defaults
- **WHEN** a write request omits namespace and collection
- **THEN** the persisted memory stores namespace `global` and collection `general`

#### Scenario: Provided namespace and collection are preserved
- **WHEN** a write request includes namespace and collection
- **THEN** the persisted memory stores the provided values unchanged
