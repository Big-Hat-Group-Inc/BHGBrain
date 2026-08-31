## ADDED Requirements

### Requirement: Restore serialization SHALL fail safe
The system SHALL release restore lifecycle guards and in-progress state when a restore attempt fails before activation fully completes.

#### Scenario: Restore setup fails before activation completes
- **WHEN** a restore attempt fails while establishing restore serialization or before activation finishes
- **THEN** the failed attempt does not leave restore state stuck in progress
- **AND** a later restore attempt can start normally

### Requirement: Activation success SHALL not be masked by later degraded work
A restore that has already activated runtime SQLite state MUST NOT be reported as a complete failure solely because later post-activation recovery work fails.

#### Scenario: Post-activation work fails
- **WHEN** runtime SQLite activation succeeds and later post-activation vector recovery work fails
- **THEN** the system does not report that activation itself failed
- **AND** the restore response preserves explicit activation success metadata
- **AND** the remaining recovery work is surfaced through degraded readiness details
