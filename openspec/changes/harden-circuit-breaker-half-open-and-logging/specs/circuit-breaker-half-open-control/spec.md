## ADDED Requirements

### Requirement: Single in-flight Half-Open probe

In the Half-Open state the breaker SHALL admit exactly one trial request at a time, short-circuiting all other concurrent callers with `CircuitOpenError` until that trial resolves.

#### Scenario: Concurrent callers during Half-Open

- **WHEN** the breaker is in Half-Open and multiple `execute()` calls arrive concurrently
- **AND** no trial request is currently in flight for the first of them
- **THEN** exactly one call is admitted to run the trial request
- **AND** every other concurrent call fast-fails with `CircuitOpenError` until the trial resolves

#### Scenario: Probe outcome drives state and releases the gate

- **WHEN** the single admitted Half-Open trial request resolves
- **AND** it succeeded (meeting `halfOpenProbeCount`) or failed
- **THEN** the breaker transitions to Closed on success or back to Open on failure
- **AND** the in-flight probe gate is released so the next eligible call can probe

### Requirement: Log every breaker state transition

The breaker SHALL emit a structured (Pino) log event on every state transition that includes the breaker key and the from-state and to-state.

#### Scenario: Closed to Open transition is logged

- **WHEN** consecutive failures reach `failure_threshold` and the breaker transitions Closed→Open
- **THEN** a `warn`-level structured log is emitted
- **AND** it includes the breaker key, the from-state (`closed`), the to-state (`open`), and the failure count

#### Scenario: Recovery transitions are logged

- **WHEN** the breaker transitions Open→Half-Open, Half-Open→Closed, or Half-Open→Open
- **THEN** a structured log event is emitted for that transition
- **AND** it includes the breaker key and the from-state and to-state

### Requirement: One breaker failure per logical Azure embed request

The Azure-Foundry embedding provider SHALL record at most one breaker failure per logical `embedBatch` call regardless of how many internal retry attempts it makes.

#### Scenario: Exhausted retries count as a single failure

- **WHEN** a single `embedBatch` call retries up to `retry.max_attempts` and every attempt fails
- **AND** the call is wrapped at the `requestWithRetry` boundary
- **THEN** the breaker records exactly one failure for that logical call

#### Scenario: Health check bypasses the breaker

- **WHEN** the provider runs its `healthCheck`
- **THEN** the request does not pass through the breaker
- **AND** no breaker success or failure is recorded for it
