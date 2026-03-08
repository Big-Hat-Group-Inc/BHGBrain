## ADDED Requirements

### Requirement: Write pipeline SHALL support extraction into atomic candidates
The system SHALL transform input content into one or more atomic memory candidates before persistence when extraction is enabled.

#### Scenario: Extraction enabled creates multiple candidates
- **WHEN** submitted content contains multiple distinct memory facts
- **THEN** the pipeline emits multiple candidates with inferred metadata for decisioning

#### Scenario: Extraction disabled stores a single candidate
- **WHEN** extraction is disabled in configuration
- **THEN** the pipeline emits exactly one candidate containing normalized input content

### Requirement: Candidate decisioning SHALL classify ADD UPDATE DELETE or NOOP
For each candidate, the system SHALL retrieve similar namespace-scoped memories and classify the write operation as ADD, UPDATE, DELETE, or NOOP.

#### Scenario: No equivalent memory results in ADD
- **WHEN** candidate similarity search finds no equivalent prior memory
- **THEN** the pipeline classifies the candidate as ADD and persists a new memory

#### Scenario: Candidate refinement results in UPDATE
- **WHEN** a candidate refines an existing memory fact
- **THEN** the pipeline classifies UPDATE and updates the existing memory while preserving required identity metadata

#### Scenario: Candidate invalidation results in DELETE
- **WHEN** a candidate explicitly invalidates a prior memory
- **THEN** the pipeline classifies DELETE and removes the stale memory while storing the correction

#### Scenario: Redundant candidate results in NOOP
- **WHEN** a candidate is redundant with an existing memory
- **THEN** the pipeline classifies NOOP and returns the existing memory id without new persistence

### Requirement: Deterministic fallback SHALL operate without extraction models
When extraction or classification models are unavailable, the system SHALL apply deterministic checksum and similarity-based decisioning using configured thresholds.

#### Scenario: Exact checksum match yields NOOP in fallback mode
- **WHEN** fallback mode processes a candidate with an identical checksum in the same namespace
- **THEN** the candidate is classified as NOOP

#### Scenario: High-similarity candidate yields UPDATE in fallback mode
- **WHEN** fallback mode finds nearest similarity at or above threshold
- **THEN** the candidate is classified as UPDATE with deterministic merge policy

#### Scenario: Below-threshold candidate yields ADD in fallback mode
- **WHEN** fallback mode finds nearest similarity below threshold
- **THEN** the candidate is classified as ADD
