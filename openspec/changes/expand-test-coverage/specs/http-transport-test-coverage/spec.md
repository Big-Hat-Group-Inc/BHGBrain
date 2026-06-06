## ADDED Requirements

### Requirement: HTTP transport tests run in-process without binding a real socket
The HTTP transport test suite SHALL exercise the Express application in-process via
`supertest(app)` and SHALL NOT bind a real network socket. The suite SHALL NOT call
`.listen()`, SHALL NOT issue requests through `fetch` to an ephemeral port, and SHALL
NOT require connection-teardown plumbing (`closeIdleConnections` / `closeAllConnections`
/ `close`) or a raised request timeout to stay green. This preserves determinism and
avoids the CI port-pressure and connection-teardown flakiness the design rules out.

#### Scenario: Routes are asserted without a listening server
- **WHEN** an HTTP transport test issues a request against the configured Express app
- **THEN** the request is dispatched in-process via `supertest(app)`
- **AND** no real TCP socket is bound and `.listen()` is never called

#### Scenario: Degraded health returns 200
- **WHEN** the health stub reports `status: 'degraded'`
- **THEN** `GET /health` returns HTTP 200 with the health body
- **AND** the response is distinguished from the `unhealthy`→503 path
