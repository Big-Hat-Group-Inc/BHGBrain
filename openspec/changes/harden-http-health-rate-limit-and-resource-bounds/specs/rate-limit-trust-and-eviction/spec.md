## ADDED Requirements

### Requirement: Rate limiting uses trusted client identity
Rate limiting SHALL derive client identity from trusted request context and MUST NOT rely solely on caller-controlled headers.

#### Scenario: Caller rotates x-client-id headers from same source
- **WHEN** repeated requests originate from same trusted identity with varying `x-client-id` values
- **THEN** rate limiting applies against the trusted identity and cannot be bypassed by header rotation

### Requirement: Rate limiter storage is bounded over time
The rate limiter MUST evict expired client buckets to avoid unbounded memory growth.

#### Scenario: High-cardinality client activity over multiple windows
- **WHEN** many distinct clients send requests and buckets expire
- **THEN** expired buckets are removed and in-memory bucket count does not grow without bound
