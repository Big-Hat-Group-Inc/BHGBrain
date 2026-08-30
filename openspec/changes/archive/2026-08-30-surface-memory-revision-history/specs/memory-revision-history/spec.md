## ADDED Requirements

### Requirement: Revision history SHALL be readable
The revision history recorded on every content change SHALL be exposed via the MCP
surface (tool and resource), newest first, under the same visibility rules as the
memory itself.

#### Scenario: Memory with prior updates
- **WHEN** a client lists revisions for a memory that has been updated
- **THEN** each recorded revision SHALL be returned with revision number, content,
  updated_at, and updated_by, ordered newest first

#### Scenario: Memory never updated
- **WHEN** a client lists revisions for a memory with no content changes
- **THEN** an empty list SHALL be returned (not an error)

### Requirement: A memory SHALL be revertible to a prior revision
Reverting SHALL restore the chosen revision's content through the normal update path —
new checksum, re-embedded vector, appended (not rewritten) history — and record a
distinct lifecycle audit event.

#### Scenario: Successful revert
- **WHEN** a client reverts a memory to revision N
- **THEN** the memory's content SHALL equal revision N's content
- **AND** the pre-revert content SHALL be preserved as a new history entry
- **AND** the vector store SHALL be updated with an embedding of the restored content
- **AND** a REVISE audit event SHALL record the source revision

#### Scenario: Embedding provider unavailable
- **WHEN** a revert is requested while the embedding provider is unavailable
- **THEN** the revert SHALL fail with EMBEDDING_UNAVAILABLE
- **AND** the memory SHALL remain unchanged
