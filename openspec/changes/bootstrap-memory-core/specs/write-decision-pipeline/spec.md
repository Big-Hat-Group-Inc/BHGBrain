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

## MODIFIED Requirements

### Requirement: Candidate decisioning SHALL classify ADD UPDATE DELETE or NOOP
For each candidate, the system SHALL retrieve similar namespace-scoped memories and
classify the write operation as ADD, UPDATE, DELETE, or NOOP. The classifier MUST be
able to emit every one of these operations that the spec defines a scenario for; an
operation that is declared and typed but never produced is a defect. When the
classifier selects UPDATE, it MUST resolve a concrete target memory before persistence,
and a missing target MUST NOT be silently converted into a duplicate ADD.

#### Scenario: No equivalent memory results in ADD
- **WHEN** candidate similarity search finds no equivalent prior memory
- **THEN** the pipeline classifies the candidate as ADD and persists a new memory

#### Scenario: Candidate refinement results in UPDATE
- **WHEN** a candidate refines an existing memory fact
- **THEN** the pipeline classifies UPDATE and updates the existing memory while preserving required identity metadata

#### Scenario: Candidate invalidation results in DELETE
- **WHEN** a candidate explicitly invalidates a prior memory
- **THEN** the classifier MUST emit DELETE (the operation MUST be reachable, not merely typed), removing the stale memory while storing the correction

#### Scenario: Redundant candidate results in NOOP
- **WHEN** a candidate is redundant with an existing memory
- **THEN** the pipeline classifies NOOP and returns the existing memory id without new persistence

#### Scenario: UPDATE target missing does not silently duplicate
- **WHEN** the classifier selects UPDATE but the resolved target memory cannot be loaded (e.g. SQLite/Qdrant drift)
- **THEN** the pipeline MUST NOT silently fall through to ADD; it SHALL surface the divergence by raising an error or, if it degrades to ADD, by emitting an explicit warning log/metric that records the missing target

### Requirement: Deterministic fallback SHALL operate without extraction models
When extraction or classification models are unavailable, the system SHALL apply
deterministic checksum and similarity-based decisioning using configured thresholds.
The fallback MUST apply the similarity threshold to choose between UPDATE and ADD — it
SHALL NOT unconditionally ADD every non-checksum-matching candidate.

#### Scenario: Exact checksum match yields NOOP in fallback mode
- **WHEN** fallback mode processes a candidate with an identical checksum in the same namespace
- **THEN** the candidate is classified as NOOP

#### Scenario: High-similarity candidate yields UPDATE in fallback mode
- **WHEN** fallback mode finds nearest similarity at or above threshold (via a vectorless similarity proxy such as full-text/trigram matching when no embedding vector is available)
- **THEN** the candidate MUST be classified as UPDATE with deterministic merge policy, not ADD

#### Scenario: Below-threshold candidate yields ADD in fallback mode
- **WHEN** fallback mode finds nearest similarity below threshold
- **THEN** the candidate is classified as ADD
