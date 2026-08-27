## ADDED Requirements

### Requirement: Every vector SHALL record its embedding identity
Vector-producing writes SHALL stamp a provider-qualified model identity (provider,
model, dimensions) on the memory row and the vector payload.

#### Scenario: New memory written
- **WHEN** a memory is stored or updated with an embedding
- **THEN** the active embedding identity SHALL be persisted with the row and the
  vector payload

### Requirement: Model changes SHALL be detected at startup and surfaced
The store SHALL persist its expected embedding identity and compare it with active
configuration at startup; mismatches SHALL degrade embedding health with an
explanatory message and, by default, refuse vector-producing writes.

#### Scenario: Operator changes the configured model
- **WHEN** the server starts with an embedding identity differing from the store's
  expected identity
- **THEN** the embedding health component SHALL be degraded with a message naming
  both identities
- **AND** vector-producing writes SHALL fail with an actionable error while the
  refuse-writes flag is enabled
- **AND** reads SHALL continue to be served

#### Scenario: Mixing disabled by operator choice
- **WHEN** the refuse-writes flag is disabled
- **THEN** writes SHALL proceed and SHALL be stamped with the new identity

### Requirement: A bounded re-embed migration SHALL converge the store
An operator-initiated migration SHALL re-embed memories whose stamp differs from the
active identity in bounded, resumable batches, updating the expected identity on
completion.

#### Scenario: Migration after a model change
- **WHEN** the operator runs the re-embed migration
- **THEN** mismatched memories SHALL be re-embedded and re-stamped in batches
- **AND** an interrupted run SHALL resume without repeating completed rows
- **AND** on completion the mismatch condition SHALL clear without a restart

#### Scenario: Legacy unstamped rows
- **WHEN** rows predate provenance stamping
- **THEN** they SHALL be treated as unknown identity
- **AND** included in migration only when explicitly requested
