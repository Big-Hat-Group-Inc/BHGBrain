## Purpose

Defines automated verification and shared code boundaries that prevent lifecycle, promise, transport, and recovery regressions from passing a green build.

## ADDED Requirements

### Requirement: Production and test TypeScript SHALL be type-checked
The standard lint and CI workflow SHALL type-check application and test sources and enforce type-aware rules for floating and misused promises.

#### Scenario: Test code passes a wrong mock contract
- **WHEN** a test double does not satisfy the production interface
- **THEN** the standard verification command fails before tests run

#### Scenario: Promise is launched without handling
- **WHEN** production code creates a potentially rejecting promise without await or an explicit handler
- **THEN** type-aware lint reports an error

### Requirement: Coverage SHALL be measurable and ratcheted
The repository SHALL provide a documented coverage command with thresholds initialized from the measured baseline and SHALL fail when coverage drops below them.

#### Scenario: Untested code lowers coverage
- **WHEN** a change reduces a configured coverage dimension below its threshold
- **THEN** CI fails with the affected dimension

### Requirement: Lifecycle behavior SHALL be tested against real storage
Retention and restore suites SHALL include integration tests using the real SQLite store and representative vector doubles so lifecycle guards, transactions, and state transitions are exercised together.

#### Scenario: Expired memory is collected
- **WHEN** a real-store GC integration test runs on an expired eligible memory
- **THEN** it asserts archive and delete behavior and advancing cleanup success state

### Requirement: Transport and dispatch contracts SHALL be tested bidirectionally
Tests SHALL cover MCP session create, lookup, delete, close-all, expiry, and capacity; successful forget and backup dispatch; and both directions of schema-to-dispatch name parity.

#### Scenario: Dispatcher gains a new tool without a schema
- **WHEN** a dispatch case has no registered schema or exposed tool declaration
- **THEN** the contract test fails

### Requirement: Vector payload reconstruction SHALL have one canonical mapping
Hydration, repair, and search fallback SHALL reuse one tested payload-to-memory mapping for every recoverable field and safe default.

#### Scenario: A new payload field is introduced
- **WHEN** the vector payload contract gains a lifecycle or provenance field
- **THEN** one mapper test governs all recovery and fallback consumers

### Requirement: Complex handlers SHALL expose pure testable boundaries
Review, repair, recall, and hybrid-search orchestration SHALL delegate mapping, pool sizing, and result fusion to focused functions that can be tested without full transport setup.

#### Scenario: Retrieval fusion behavior changes
- **WHEN** rank normalization or tie-breaking logic is modified
- **THEN** focused unit tests can verify membership and order from explicit candidate inputs
