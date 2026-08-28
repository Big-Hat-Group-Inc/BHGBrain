## ADDED Requirements

### Requirement: The HTTP server SHALL serve MCP via the Streamable HTTP transport
When HTTP transport is enabled, the server SHALL expose an MCP Streamable HTTP
endpoint at `/mcp` (POST for JSON-RPC requests, GET for the standalone SSE channel,
DELETE for session termination), backed by the same tool and resource handlers as the
stdio transport.

#### Scenario: MCP client connects over HTTP
- **WHEN** an MCP client POSTs an `initialize` request to `/mcp`
- **THEN** the server SHALL complete the MCP handshake and return an
  `Mcp-Session-Id` header identifying the new session
- **AND** subsequent `tools/list`, `tools/call`, `resources/list`, and
  `resources/read` requests bearing that header SHALL be served with results
  identical to the stdio transport's

#### Scenario: Multiple clients share one process
- **WHEN** two MCP clients each initialize their own session against the same server
- **THEN** each session SHALL have its own protocol state
- **AND** both SHALL read and write the same underlying memory store

### Requirement: Sessions SHALL be validated and terminable
Session handling SHALL follow the Streamable HTTP specification: unknown session ids
rejected, sessionless non-initialize requests rejected, and explicit termination
supported.

#### Scenario: Unknown session id
- **WHEN** a request arrives with an `Mcp-Session-Id` that no live session matches
- **THEN** the server SHALL respond 404

#### Scenario: Missing session id
- **WHEN** a non-initialize request arrives with no `Mcp-Session-Id` header
- **THEN** the server SHALL respond 400

#### Scenario: Client terminates its session
- **WHEN** a client sends `DELETE /mcp` with its session id
- **THEN** that session's transport SHALL be closed and removed
- **AND** later requests with that id SHALL receive 404

### Requirement: MCP-over-HTTP SHALL inherit the HTTP security posture
The `/mcp` routes SHALL sit behind the same bearer-token authentication, rate
limiting, and request-size limiting as the existing REST endpoints.

#### Scenario: Unauthenticated MCP request
- **WHEN** a bearer token is configured and a request to `/mcp` lacks a valid
  `Authorization` header
- **THEN** the server SHALL respond 401 without creating or touching any session

#### Scenario: Rate-limited MCP client
- **WHEN** a client exceeds the configured request rate against `/mcp`
- **THEN** the rate-limit middleware SHALL reject the request exactly as it does for
  REST endpoints

### Requirement: Transports SHALL be torn down cleanly on shutdown
Process shutdown SHALL close every live session transport before exit.

#### Scenario: Server receives a termination signal
- **WHEN** the HTTP-mode process receives SIGINT or SIGTERM
- **THEN** all live Streamable HTTP session transports SHALL be closed
- **AND** the session registry SHALL be empty before the process exits

### Requirement: The REST convenience layer SHALL be preserved
`POST /tool/:name` and `GET /resource` SHALL continue to work unchanged as the
documented non-MCP REST surface.

#### Scenario: Existing REST caller
- **WHEN** a caller invokes `POST /tool/:name` or `GET /resource` on a server that
  also serves `/mcp`
- **THEN** responses SHALL be identical to the pre-change behavior
