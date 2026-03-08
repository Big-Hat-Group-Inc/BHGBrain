## ADDED Requirements

### Requirement: HTTP transport SHALL default to secure local-only behavior
When HTTP transport is enabled, the server SHALL bind to loopback by default and SHALL require explicit opt-in for non-loopback binding.

#### Scenario: Default startup binds to loopback
- **WHEN** server starts with default transport configuration
- **THEN** HTTP binds to `127.0.0.1`

#### Scenario: Non-loopback bind requires explicit configuration
- **WHEN** server configuration sets a non-loopback host
- **THEN** startup is rejected unless explicit non-loopback opt-in is enabled

### Requirement: HTTP requests SHALL require bearer authentication
HTTP tool and resource requests SHALL require `Authorization: Bearer <token>` and SHALL reject missing or invalid tokens.

#### Scenario: Missing token is rejected
- **WHEN** a client sends a request without bearer authorization
- **THEN** the server responds with `AUTH_REQUIRED`

#### Scenario: Invalid token is rejected
- **WHEN** a client sends a request with an invalid token
- **THEN** the server responds with `AUTH_REQUIRED`

### Requirement: Request protections SHALL enforce rate and payload limits
The server SHALL enforce per-client rate limits and maximum request payload size using configured defaults.

#### Scenario: Exceeding request rate limit is blocked
- **WHEN** a client exceeds configured requests per minute
- **THEN** the server responds with `RATE_LIMITED`

#### Scenario: Oversized request payload is rejected
- **WHEN** a request body exceeds configured maximum size
- **THEN** the server rejects the request with `INVALID_INPUT`
