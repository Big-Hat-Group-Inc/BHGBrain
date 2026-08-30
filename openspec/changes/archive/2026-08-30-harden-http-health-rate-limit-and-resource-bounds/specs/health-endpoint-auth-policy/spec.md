## ADDED Requirements

### Requirement: Health endpoint has explicit unauthenticated access policy
The HTTP transport SHALL allow health checks to be served without bearer token requirements.

#### Scenario: Token configured and health probe request
- **WHEN** a request is made to `/health` without an `Authorization` header
- **THEN** the server responds with health payload and does not return `AUTH_REQUIRED`

### Requirement: Health endpoint remains loopback-scoped with normal transport safety controls
Health endpoint exposure MUST remain constrained by loopback binding policy unless explicitly configured otherwise.

#### Scenario: Non-loopback host with loopback enforcement enabled
- **WHEN** HTTP host is configured to non-loopback and loopback enforcement is enabled
- **THEN** server startup fails before serving any route, including `/health`
