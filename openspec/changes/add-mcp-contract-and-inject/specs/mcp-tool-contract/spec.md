## ADDED Requirements

### Requirement: All MCP tools SHALL enforce strict input schemas
Each v1 tool SHALL define strict JSON schema with required fields, bounds, enums, and `additionalProperties: false`.

#### Scenario: Unknown input field is rejected
- **WHEN** a client sends a tool request containing unknown properties
- **THEN** the server rejects the request with `INVALID_INPUT`

#### Scenario: Out-of-bounds input is rejected
- **WHEN** a client sends an input exceeding configured length or numeric limits
- **THEN** the server rejects the request with `INVALID_INPUT`

### Requirement: Tool responses SHALL match declared output contracts
Each v1 tool SHALL return output fields exactly as defined for the tool contract, including operation-specific optional fields.

#### Scenario: remember returns operation outcome
- **WHEN** `remember` succeeds
- **THEN** response includes `id`, `summary`, `type`, `operation`, and `created_at`

#### Scenario: collections list returns names and counts
- **WHEN** `collections` is called with action `list`
- **THEN** response includes `collections` entries with `name` and `count`

### Requirement: Tool errors SHALL use a standard envelope
All tool failures SHALL return a standard error envelope with `code`, `message`, and `retryable`.

#### Scenario: Validation failure emits standard envelope
- **WHEN** tool input fails schema validation
- **THEN** the response is `{ error: { code: "INVALID_INPUT", message, retryable: false } }`

#### Scenario: Dependency outage emits standardized code
- **WHEN** embedding is unavailable during a write path
- **THEN** the response uses `EMBEDDING_UNAVAILABLE` and does not silently succeed
