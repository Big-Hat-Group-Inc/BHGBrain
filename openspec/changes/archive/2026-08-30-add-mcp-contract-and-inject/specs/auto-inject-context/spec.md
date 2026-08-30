## ADDED Requirements

### Requirement: Session inject resource SHALL assemble context in fixed order
`memory://inject` SHALL compose payloads in this order: full category content first, then top relevant memories, then truncation handling.

#### Scenario: Inject includes category content before recalled memories
- **WHEN** a client requests `memory://inject?namespace=<name>`
- **THEN** category content appears before any recalled memory entries in the payload

#### Scenario: Inject includes top-k recalled memories
- **WHEN** relevant memories are available for the namespace
- **THEN** the inject payload includes up to configured top-k recalled memories

### Requirement: Inject response SHALL enforce budget limits with truncation metadata
Inject responses SHALL enforce configured maximum payload size and SHALL set truncation metadata when content is reduced.

#### Scenario: Over-budget payload is truncated with metadata
- **WHEN** composed inject content exceeds configured max chars
- **THEN** payload content is truncated using summary fallback and response includes `truncated: true`

#### Scenario: Under-budget payload is returned untruncated
- **WHEN** composed inject content is within configured max chars
- **THEN** response includes complete composed payload with `truncated: false`
