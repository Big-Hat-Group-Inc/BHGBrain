## ADDED Requirements

### Requirement: Tool responses are structured for MCP clients
MCP tool call responses SHALL include machine-readable structured content for successful outcomes.

#### Scenario: Successful tool call
- **WHEN** a tool completes successfully
- **THEN** response includes structured payload without requiring JSON parsing from plain text

### Requirement: Tool errors are explicitly flagged
MCP tool call failures SHALL set MCP error signaling fields for client/runtime routing.

#### Scenario: Tool validation failure
- **WHEN** input validation fails
- **THEN** response marks the call as error (e.g., `isError: true`) and includes structured error payload

### Requirement: Resource discovery exposes templates correctly
Parameterized resources SHALL be exposed through MCP resource template mechanisms rather than placeholder concrete URIs.

#### Scenario: Resource discovery request
- **WHEN** client lists resources/templates
- **THEN** dynamic URI patterns are discoverable as templates
