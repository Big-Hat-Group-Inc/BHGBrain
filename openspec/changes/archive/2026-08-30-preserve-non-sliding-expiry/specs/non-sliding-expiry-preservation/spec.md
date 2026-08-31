## ADDED Requirements

### Requirement: Non-sliding access updates preserve existing expiry
When sliding-window expiry is disabled and an access update does not change the memory's tier, the system SHALL preserve the existing `expires_at` value.

#### Scenario: Access tracking preserves expiry for an unchanged tier
- **WHEN** a T2 or T3 memory has an existing expiry timestamp
- **AND** `sliding_window_enabled` is `false`
- **AND** an access update records a new access count without promoting the memory
- **THEN** the system updates access metadata
- **AND** the stored expiry timestamp remains unchanged

### Requirement: Expiry-clearing semantics are explicit
The lifecycle and storage update contracts SHALL distinguish “do not change expiry” from “clear expiry” so access paths cannot remove TTLs implicitly.

#### Scenario: No-change expiry input does not clear stored TTL
- **WHEN** the read path submits an access update that indicates expiry should remain unchanged
- **THEN** the storage layer preserves the existing `expires_at` value
- **AND** it does not interpret the update as an instruction to write `null`

### Requirement: Promotion still applies tier lifecycle policy under non-sliding mode
When an access update promotes a memory into a new tier, the system SHALL recompute expiry for the promoted tier even if sliding-window extension is disabled.

#### Scenario: Promotion recalculates expiry under non-sliding mode
- **WHEN** `sliding_window_enabled` is `false`
- **AND** a memory crosses the promotion threshold during an access update
- **THEN** the system updates the retained tier
- **AND** it applies the promoted tier's lifecycle metadata, including recomputed expiry when that tier has one
