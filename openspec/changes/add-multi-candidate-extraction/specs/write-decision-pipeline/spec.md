## MODIFIED Requirements

### Requirement: Write pipeline SHALL support extraction into atomic candidates
The system SHALL transform input content into one or more atomic memory candidates
before persistence when `pipeline.extraction_enabled` is true and an extraction model
key resolves (`pipeline.extraction_model_env`, falling back to `OPENAI_API_KEY`). This
replaces the prior always-single-candidate behavior: `pipeline.extraction_enabled` /
`pipeline.extraction_model` now actually govern candidate count instead of being
reserved, inert configuration. Extraction is skipped for content shorter than
`pipeline.extraction_min_chars`, and its output is capped at
`pipeline.extraction_max_candidates`. Any extraction failure — disabled configuration,
no resolvable key, network error, timeout, or a malformed/empty/invalid model
response — MUST fall back to emitting exactly one candidate containing the normalized
input content, matching the pre-existing v1 behavior; extraction failure MUST NOT raise
an error or block the write.

#### Scenario: Extraction enabled splits multi-fact content into multiple candidates
- **WHEN** `pipeline.extraction_enabled` is true, a key resolves, submitted content is
  at least `extraction_min_chars` long, and the content contains multiple distinct
  memory facts
- **THEN** the pipeline emits multiple atomic candidates, each with inferred metadata,
  each independently decisioned by the existing ADD/UPDATE/DELETE/NOOP classifier

#### Scenario: Extraction disabled stores a single candidate
- **WHEN** `pipeline.extraction_enabled` is false (the default)
- **THEN** the pipeline emits exactly one candidate containing normalized input content
  and never attempts a model call

#### Scenario: Content below the length gate skips the model call
- **WHEN** normalized content length is below `pipeline.extraction_min_chars`
- **THEN** the pipeline emits exactly one candidate without invoking the extraction
  provider

#### Scenario: Extraction model failure falls back to single-candidate extraction
- **WHEN** extraction is enabled and gated-in, but the model call fails (network error,
  timeout, or the circuit breaker is open) or the response fails schema validation or is
  empty
- **THEN** the pipeline emits exactly one candidate containing normalized input content,
  identical to the disabled-extraction path, and the write proceeds without error

#### Scenario: Extraction output beyond the candidate cap is truncated, not merged
- **WHEN** a valid extraction response contains more candidates than
  `pipeline.extraction_max_candidates`
- **THEN** the pipeline accepts only the first `extraction_max_candidates` candidates and
  discards the remainder, logging the truncation

### Requirement: Candidate decisioning SHALL classify ADD UPDATE DELETE or NOOP
For each candidate, the system SHALL retrieve similar namespace-scoped memories and
classify the write operation as ADD, UPDATE, DELETE, or NOOP. The classifier MUST be
able to emit every one of these operations that the spec defines a scenario for; an
operation that is declared and typed but never produced is a defect. When the
classifier selects UPDATE, it MUST resolve a concrete target memory before persistence,
and a missing target MUST NOT be silently converted into a duplicate ADD. A failure
classifying or persisting one candidate in a multi-candidate batch MUST NOT prevent
sibling candidates in the same batch from being attempted and returned.

#### Scenario: No equivalent memory results in ADD
- **WHEN** candidate similarity search finds no equivalent prior memory
- **THEN** the pipeline classifies the candidate as ADD and persists a new memory

#### Scenario: Candidate refinement results in UPDATE
- **WHEN** a candidate refines an existing memory fact
- **THEN** the pipeline classifies UPDATE and updates the existing memory while
  preserving required identity metadata

#### Scenario: Candidate invalidation results in DELETE
- **WHEN** a candidate explicitly invalidates a prior memory
- **THEN** the classifier MUST emit DELETE (the operation MUST be reachable, not merely
  typed), removing the stale memory while storing the correction

#### Scenario: Redundant candidate results in NOOP
- **WHEN** a candidate is redundant with an existing memory
- **THEN** the pipeline classifies NOOP and returns the existing memory id without new
  persistence

#### Scenario: UPDATE target missing does not silently duplicate
- **WHEN** the classifier selects UPDATE but the resolved target memory cannot be
  loaded (e.g. SQLite/Qdrant drift)
- **THEN** the pipeline MUST NOT silently fall through to ADD; it SHALL surface the
  divergence by raising an error or, if it degrades to ADD, by emitting an explicit
  warning log/metric that records the missing target

#### Scenario: One candidate's failure does not discard sibling results
- **WHEN** a multi-candidate batch has one candidate whose decisioning or persistence
  throws (e.g. an UPDATE-target lookup failure)
- **THEN** the pipeline logs and counts the failed candidate, continues processing
  remaining candidates, and returns every successfully-produced `WriteResult` rather
  than discarding them
- **AND** if every candidate in the batch failed, the pipeline raises an error
  (preserving single-candidate throw behavior when the batch has exactly one candidate)

## ADDED Requirements

### Requirement: Extraction cost and latency SHALL be bounded by configuration
The extraction model call SHALL be time-boxed and SHALL be skipped for content below a
configurable length threshold, so enabling extraction has a predictable and bounded
cost/latency impact rather than an unconditional per-write model call.

#### Scenario: Extraction request exceeds its timeout
- **WHEN** the extraction model call does not complete within
  `pipeline.extraction_timeout_ms`
- **THEN** the request is aborted and treated as an extraction failure (single-candidate
  fallback applies)

#### Scenario: Repeated extraction failures open the extraction circuit breaker
- **WHEN** the extraction call fails repeatedly past the configured failure threshold
- **THEN** subsequent calls within the batch/open window skip the network call entirely
  and go directly to single-candidate fallback
- **AND** the extraction breaker's open state is excluded from overall `/health` status
  aggregation, since a fully-functional fallback exists

### Requirement: Extraction key resolution SHALL fall back from the extraction-specific
variable to the shared OpenAI key
The system SHALL resolve the extraction model's API key from the environment variable
named by `pipeline.extraction_model_env`, falling back to `OPENAI_API_KEY` when that
variable is unset, before treating extraction as unavailable.

#### Scenario: Dedicated extraction key is set
- **WHEN** the environment variable named by `pipeline.extraction_model_env` is set
- **THEN** that value is used to authenticate the extraction model call

#### Scenario: Dedicated extraction key is unset but OPENAI_API_KEY is set
- **WHEN** the environment variable named by `pipeline.extraction_model_env` is unset
- **AND** `OPENAI_API_KEY` is set
- **THEN** `OPENAI_API_KEY` is used to authenticate the extraction model call

#### Scenario: No key resolves
- **WHEN** neither the dedicated extraction variable nor `OPENAI_API_KEY` is set
- **THEN** extraction is treated as unavailable for the process lifetime (equivalent to
  disabled), logged once at startup, and every `remember` call uses single-candidate
  extraction without attempting a model call
