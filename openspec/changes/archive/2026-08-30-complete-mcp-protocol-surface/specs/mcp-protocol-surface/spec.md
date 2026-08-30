## ADDED Requirements

### Requirement: Tool definitions SHALL carry titles and truthful behavioral annotations
Every MCP tool definition SHALL include a human-readable `title` and `annotations`
declaring `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
`openWorldHint: false`, matching the tool's actual behavior.

#### Scenario: Read-only tools stop defaulting to dangerous
- **WHEN** a client lists tools
- **THEN** `recall` and `search` SHALL advertise `readOnlyHint: true`
- **AND** SHALL NOT be subject to the spec default `destructiveHint: true`

#### Scenario: Destructive tools say so
- **WHEN** a client lists tools
- **THEN** `forget`, `collections`, `category`, `backup`, and `revisions` SHALL
  advertise `destructiveHint: true`

### Requirement: Structured tool results SHALL be validatable via outputSchema
`recall`, `search`, and `remember` SHALL declare an `outputSchema`, and their MCP
`structuredContent` SHALL conform to it on every successful call.

#### Scenario: Remember result envelope is stable
- **WHEN** `remember` succeeds over MCP, whether producing one write result or several
- **THEN** `structuredContent` SHALL be `{ results: [...] }` conforming to the
  declared schema
- **AND** the JSON text block SHALL serialize the same envelope

### Requirement: serverInfo SHALL report the real package version
The MCP `serverInfo.version` SHALL equal the `version` field of `package.json`.

#### Scenario: Version bump propagates
- **WHEN** `package.json` version changes and the server restarts
- **THEN** initialize responses SHALL carry the new version with no code edit

### Requirement: Unknown tool names SHALL fail as protocol errors
A `tools/call` naming a tool the server does not define SHALL produce a JSON-RPC
InvalidParams error (`-32602`), while execution failures of defined tools SHALL remain
`isError` tool results.

#### Scenario: Unknown tool
- **WHEN** a client calls tool name `does-not-exist`
- **THEN** the response SHALL be a JSON-RPC error, not a tool result

#### Scenario: Known tool with bad input
- **WHEN** a client calls `forget` with a malformed id
- **THEN** the response SHALL be an `isError` tool result carrying the error envelope

### Requirement: The server SHALL expose onboarding and session prompts
The server SHALL declare the `prompts` capability and serve `bootstrap-interview` and
`session-context` prompts.

#### Scenario: Bootstrap interview via prompts
- **WHEN** a client gets the `bootstrap-interview` prompt
- **THEN** the messages SHALL direct the client through the interview sections using
  the `bootstrap` tool
- **AND** an out-of-range `section` argument SHALL be rejected as InvalidParams

#### Scenario: Session context via prompts
- **WHEN** a client gets the `session-context` prompt
- **THEN** the messages SHALL contain the budgeted `memory://inject` context block

### Requirement: Resource list mutations SHALL emit list_changed notifications
The server SHALL declare `resources.listChanged` and send
`notifications/resources/list_changed` after collection create/delete and category
set/delete.

#### Scenario: Collection created over stdio
- **WHEN** a `collections` call with `action: "create"` succeeds on the MCP transport
- **THEN** a `notifications/resources/list_changed` SHALL be sent

#### Scenario: Read actions stay silent
- **WHEN** a `collections` or `category` call with `action: "list"` completes, or a
  mutation fails
- **THEN** no list_changed notification SHALL be sent

### Requirement: MCP payloads SHALL be compact JSON
Tool result text blocks and resource read contents SHALL be serialized without
pretty-print indentation.

#### Scenario: Tool call payload
- **WHEN** any tool result is rendered for MCP
- **THEN** the text block SHALL contain no indentation whitespace beyond the data
  itself
