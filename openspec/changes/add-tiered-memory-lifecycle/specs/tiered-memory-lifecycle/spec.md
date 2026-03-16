## ADDED Requirements

### Requirement: Memory records SHALL persist canonical lifecycle metadata
The system SHALL persist lifecycle metadata on each memory record including `retention_tier`, `expires_at`, `decay_eligible`, `review_due`, access tracking fields, and archival state.

#### Scenario: Foundational memory stores non-expiring lifecycle metadata
- **WHEN** a memory is assigned tier `T0`
- **THEN** the persisted record stores `retention_tier = T0`
- **AND** `expires_at` is null
- **AND** the memory is marked non-decay-eligible

#### Scenario: Transient memory stores expiry metadata
- **WHEN** a memory is assigned tier `T3`
- **THEN** the persisted record stores a concrete `expires_at`
- **AND** the memory is marked decay-eligible

### Requirement: The write pipeline SHALL assign retention tiers deterministically
The system SHALL assign a retention tier at write time using explicit caller input first, then category rules, source/content heuristics, extraction output, and finally a default operational tier.

#### Scenario: Explicit tier input overrides heuristics
- **WHEN** a caller supplies a valid `retention_tier`
- **THEN** the stored memory uses that tier
- **AND** lower-priority heuristics do not override it

#### Scenario: Persistent category content is always foundational
- **WHEN** a memory is written as a persistent category entry
- **THEN** the system assigns tier `T0`

#### Scenario: Unclassified content defaults to operational
- **WHEN** no explicit tier, category rule, heuristic, or extraction recommendation applies
- **THEN** the system assigns tier `T2`

### Requirement: Retrieval paths SHALL enforce lifecycle visibility consistently
The system SHALL apply lifecycle-aware retrieval behavior consistently across MCP tools, resources, and CLI queries.

#### Scenario: Expired transient memory is excluded from default reads
- **WHEN** a `T3` memory has passed `expires_at`
- **THEN** default retrieval paths do not return it as an active memory

#### Scenario: Foundational and institutional memories remain eligible
- **WHEN** a retrieval request executes ranking
- **THEN** `T0` and `T1` memories remain eligible regardless of transient expiry filters

#### Scenario: Successful read updates access state
- **WHEN** a memory is returned through a retrieval path
- **THEN** the system increments access tracking
- **AND** updates `last_accessed`
- **AND** extends sliding expiry windows for eligible tiers when enabled

### Requirement: Lifecycle policy SHALL support promotion without automatic demotion
The system SHALL support access-driven promotion for eligible memories and SHALL not automatically demote memories.

#### Scenario: Frequently accessed transient memory is promoted
- **WHEN** a `T3` or `T2` memory reaches the configured access threshold inside its active TTL window
- **THEN** the system promotes it by one retention tier

#### Scenario: Memory is never auto-demoted
- **WHEN** a promoted or manually classified memory becomes inactive
- **THEN** the system does not reduce its tier automatically

### Requirement: Cleanup SHALL archive and delete only eligible memories
The system SHALL enforce lifecycle cleanup for decay-eligible memories and SHALL archive before delete when archival is enabled.

#### Scenario: Eligible transient memory is archived before delete
- **WHEN** a decay-eligible memory reaches cleanup eligibility
- **THEN** the system writes an archive summary before deleting active records

#### Scenario: Foundational memory is excluded from cleanup deletion
- **WHEN** cleanup evaluates tier `T0`
- **THEN** the memory is never selected for archive/delete by retention policy

#### Scenario: Institutional memory requires inactivity and warning window
- **WHEN** a `T1` memory has been inactive beyond its review and expiry policy
- **THEN** the system flags it for warning/review before any deletion path is eligible

### Requirement: Foundational updates SHALL preserve revision history
The system SHALL preserve prior content revisions for tier `T0` memories.

#### Scenario: Updating a foundational memory records the previous version
- **WHEN** a `T0` memory is updated
- **THEN** the prior content is written to a revision history store
- **AND** the active semantic index contains only the latest version

### Requirement: The application SHALL provide lifecycle administration interfaces
The system SHALL expose lifecycle administration via CLI and retention-aware metadata in MCP responses.

#### Scenario: CLI shows tier and expiry details
- **WHEN** an operator runs `bhgbrain tier show <id>`
- **THEN** the response includes the current tier, decay eligibility, and expiry state

#### Scenario: Cleanup dry-run reports candidates without deleting
- **WHEN** an operator runs `bhgbrain gc --dry-run`
- **THEN** the system reports cleanup candidates and counts without mutating memory state
