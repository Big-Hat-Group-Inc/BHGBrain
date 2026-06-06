## ADDED Requirements

### Requirement: Successful tool results SHALL be delivered via the MCP structuredContent field

For a successful tool call that returns an object-shaped payload, the MCP `CallToolResult` SHALL include the payload in the `structuredContent` field so clients can consume it without parsing JSON from a plain-text block. A human-readable text content block MAY be retained for backward compatibility. Error envelopes SHALL continue to set `isError: true`.

#### Scenario: Successful object result includes structuredContent

- **WHEN** a tool call succeeds and returns an object-shaped result
- **THEN** the `CallToolResult` includes the result in the `structuredContent` field
- **AND** a text content block MAY also be present for backward compatibility
- **AND** `isError` is not set

#### Scenario: Error envelope still signals isError

- **WHEN** a tool call returns a standard error envelope
- **THEN** the `CallToolResult` sets `isError: true`

### Requirement: All tool schemas SHALL reject unknown and out-of-bounds input

Each registered tool SHALL reject inputs containing unknown fields or out-of-bounds values with the `INVALID_INPUT` error envelope, and this rejection SHALL be covered by per-tool contract tests for `recall`, `search`, `tag`, `category`, and `backup`.

#### Scenario: Unknown field rejected per tool

- **WHEN** `recall`, `search`, `tag`, `category`, or `backup` is called with an unknown input field
- **THEN** the tool returns the `INVALID_INPUT` error envelope

#### Scenario: Out-of-bounds value rejected per tool

- **WHEN** `recall`, `search`, `tag`, `category`, or `backup` is called with a value outside its declared bounds
- **THEN** the tool returns the `INVALID_INPUT` error envelope
