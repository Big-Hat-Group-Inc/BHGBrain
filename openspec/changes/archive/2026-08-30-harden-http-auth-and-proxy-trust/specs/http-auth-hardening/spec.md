## ADDED Requirements

### Requirement: Bearer-token comparison is constant-time
The bearer-token authentication check SHALL compare the supplied token against the configured secret using a constant-time comparison and MUST NOT use a comparison that short-circuits on the first differing byte.

#### Scenario: Supplied token differs from the configured secret
- **WHEN** a request presents a `Bearer` token that does not equal the configured secret
- **AND** the supplied token has the same length as the configured secret
- **THEN** authentication fails with `AUTH_REQUIRED` (401)
- **AND** the comparison time does not depend on the byte position of the first difference

#### Scenario: Supplied token has a different length than the secret
- **WHEN** a request presents a `Bearer` token whose length differs from the configured secret
- **THEN** authentication fails with `AUTH_REQUIRED` (401) without throwing
- **AND** the comparison fails closed before any constant-time byte comparison is attempted

#### Scenario: Supplied token equals the configured secret
- **WHEN** a request presents a `Bearer` token that equals the configured secret
- **THEN** authentication succeeds and the request proceeds to the next handler

### Requirement: Rate-limit identity respects configured proxy trust
Rate limiting SHALL derive client identity using an explicitly configured proxy-trust policy so that proxied clients are not collapsed into a single bucket, and the server MUST configure Express `trust proxy` from configuration with a default that does not trust forwarding headers.

#### Scenario: Proxy trust is disabled (default, loopback-accurate)
- **WHEN** `security.trust_proxy` is disabled
- **AND** requests arrive with caller-supplied `X-Forwarded-For` headers
- **THEN** the rate-limit identity is derived from the direct socket peer and ignores the forwarding header
- **AND** spoofed forwarding headers cannot alter the client's rate-limit bucket

#### Scenario: Proxy trust is enabled behind a trusted reverse proxy
- **WHEN** `security.trust_proxy` is enabled
- **AND** requests arrive through a trusted reverse proxy that sets forwarding headers
- **THEN** the rate-limit identity reflects the originating client rather than the single proxy address
- **AND** distinct clients are tracked in distinct buckets

#### Scenario: Client identity cannot be derived
- **WHEN** a request has no derivable client IP
- **THEN** the limiter fails closed rather than assigning the request to a single shared fallback bucket

### Requirement: Rate-limiter state is instance-scoped
Rate-limiter bucket state SHALL be owned by the rate-limit middleware/server instance and MUST NOT be held in module-global mutable state shared across independently created server instances.

#### Scenario: Two independent server instances handle traffic
- **WHEN** two server (or middleware) instances are created in the same process
- **AND** each receives requests from clients
- **THEN** each instance maintains its own bucket state
- **AND** rate-limit counts from one instance do not affect the other

#### Scenario: Test resets limiter state
- **WHEN** a test resets a middleware instance's limiter state
- **THEN** only that instance's buckets are cleared
- **AND** no module-global shared state is mutated
