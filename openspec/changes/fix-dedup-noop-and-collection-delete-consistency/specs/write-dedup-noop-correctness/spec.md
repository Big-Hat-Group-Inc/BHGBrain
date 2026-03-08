## ADDED Requirements

### Requirement: NOOP dedup decision is terminal
The write pipeline SHALL treat a `NOOP` dedup decision as terminal and MUST NOT create or update memory records or vectors.

#### Scenario: High-similarity candidate resolves to NOOP
- **WHEN** dedup classification returns `NOOP` with a target memory id
- **THEN** the pipeline returns a `NOOP` result referencing the existing memory
- **THEN** no SQLite memory rows are inserted or updated
- **THEN** no Qdrant upsert operation is performed

### Requirement: NOOP response returns canonical existing metadata
The write pipeline SHALL return metadata from the existing memory for `NOOP` outcomes.

#### Scenario: Existing record found for NOOP target
- **WHEN** a `NOOP` decision includes a valid target id
- **THEN** the response contains the target id, summary, type, and original created timestamp from stored memory

#### Scenario: NOOP target missing in SQLite
- **WHEN** a `NOOP` decision references a missing record
- **THEN** the pipeline MUST fail with an internal error instead of silently creating a new record
