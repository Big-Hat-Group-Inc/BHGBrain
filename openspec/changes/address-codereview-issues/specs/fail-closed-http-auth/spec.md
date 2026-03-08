## ADDED Requirements

### Requirement: External HTTP deployments are fail-closed by default
HTTP transport SHALL reject insecure startup combinations where external binding is enabled without authentication, unless explicitly overridden by configuration.

#### Scenario: Non-loopback binding without bearer token
- **WHEN** HTTP host is non-loopback and bearer token is not configured
- **THEN** server startup fails with actionable configuration error

### Requirement: Unauthenticated HTTP mode is explicit
If unauthenticated HTTP is allowed, it MUST require an explicit opt-in configuration flag.

#### Scenario: Operator enables unauthenticated mode
- **WHEN** explicit unauthenticated flag is set
- **THEN** startup succeeds and logs a high-visibility security warning
