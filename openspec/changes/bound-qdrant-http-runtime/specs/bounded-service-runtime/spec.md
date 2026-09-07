## Purpose

Defines hard time, memory, concurrency, and lifecycle bounds for vector-backed HTTP and MCP service operation, including truthful readiness during dependency failures.

## ADDED Requirements

### Requirement: Vector operations SHALL have bounded deadlines and breaker coverage
Every request-path, cleanup, scan, and administrative vector operation SHALL complete or fail within a configured deadline and contribute to the shared breaker state; the independent health probe SHALL use its own short deadline.

#### Scenario: Vector service accepts connections but never responds
- **WHEN** the vector service is black-holed or stalls
- **THEN** each operation fails within the configured timeout
- **AND** repeated operational failures open the breaker and make later requests fail fast

### Requirement: Health SHALL distinguish liveness, readiness, and diagnostics
A terse unauthenticated liveness response SHALL avoid expensive dependency work, readiness SHALL fail when required storage is degraded, and detailed diagnostics SHALL require normal authentication and rate limiting.

#### Scenario: Vector service is unavailable
- **WHEN** the process is alive but semantic storage is unavailable
- **THEN** liveness can remain successful
- **AND** readiness returns a non-success status
- **AND** repeated public probes do not create one uncached dependency request each

### Requirement: MCP session state SHALL be bounded and observable
HTTP MCP sessions SHALL track activity, expire after a configurable idle interval, enforce a maximum resident count, and publish current and evicted session metrics.

#### Scenario: Clients abandon initialized sessions
- **WHEN** sessions remain idle beyond the configured lifetime
- **THEN** their server and transport resources are closed and removed
- **AND** shutdown does not inherit an unbounded registry

### Requirement: Collection fan-out SHALL use bounded concurrency
Queries without a collection SHALL cap target collections, run a configured number concurrently, and limit per-target result and payload work while exposing fan-out width.

#### Scenario: Namespace contains many collections
- **WHEN** collectionless retrieval targets more collections than the configured limit
- **THEN** the request returns a clear bounded or partial outcome rather than issuing all queries concurrently

### Requirement: Rate-limit state and proxy trust SHALL resist caller-controlled cardinality
Rate-limit buckets SHALL have a hard capacity and independent expiry sweep, and proxy trust SHALL accept explicit hop-count or subnet policies rather than a trust-all boolean.

#### Scenario: Caller rotates forwarded addresses
- **WHEN** untrusted traffic supplies arbitrary forwarded-for values
- **THEN** those values cannot bypass the configured rate limit through a trust-all proxy setting
- **AND** the bucket registry remains bounded

### Requirement: Not-found handling SHALL be operation-specific
Only a confirmed missing managed collection or point SHALL be treated idempotently; routing, authentication, timeout, and service failures SHALL remain unhealthy errors.

#### Scenario: Vector ingress returns 404 for every endpoint
- **WHEN** the collection-list or health route itself returns not found
- **THEN** health reports the vector service unavailable rather than healthy with an empty collection
