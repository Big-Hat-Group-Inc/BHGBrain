## ADDED Requirements

### Requirement: Retention service uses typed storage interfaces
Retention workflows SHALL access persistence through typed public storage methods and MUST NOT access private database internals.

#### Scenario: Mark stale memories execution
- **WHEN** retention marks stale memories using a cutoff timestamp
- **THEN** stale candidate retrieval is performed via public typed storage API
- **THEN** no `any` cast or direct private database field access is required

### Requirement: Retention behavior remains functionally equivalent after encapsulation
Refactoring for encapsulation MUST preserve stale-marking outcomes for equivalent inputs.

#### Scenario: Equivalent dataset before and after refactor
- **WHEN** retention is run against the same memory dataset and cutoff
- **THEN** the number of memories marked stale is unchanged
