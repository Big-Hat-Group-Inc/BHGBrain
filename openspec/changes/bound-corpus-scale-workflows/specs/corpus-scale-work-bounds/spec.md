## Purpose

Defines explicit resource and progress bounds for operations whose work is determined by stored corpus size, preventing event-loop monopolization and unbounded memory or network use.

## ADDED Requirements

### Requirement: Corpus traversal SHALL be paged and project only required fields
Hydration, repair, drift detection, and distillation SHALL consume vector-store pages incrementally and request only the payload and vector fields each workflow requires.

#### Scenario: Collection contains a large corpus
- **WHEN** a workflow scans a collection larger than one page
- **THEN** peak retained scan data is bounded near the configured page and work buffer
- **AND** the workflow reports resumable progress

### Requirement: Distillation SHALL enforce candidate and compute budgets
Distillation SHALL cap candidates per collection, precompute reusable similarity values, and yield between compute chunks so service health and shutdown remain responsive.

#### Scenario: Candidate population exceeds the configured cap
- **WHEN** a collection contains more eligible distillation candidates than allowed
- **THEN** the run selects a deterministic bounded subset or skips with a visible reason

### Requirement: Hot SQLite operations SHALL avoid corpus-wide repeated scans
Full-text maintenance SHALL target seekable row identifiers, and expiry, pinned, re-embedding, and repair queries SHALL use supporting indexes and keyset cursors.

#### Scenario: One memory is updated in a large full-text corpus
- **WHEN** the full-text projection for one memory is replaced
- **THEN** maintenance cost does not require scanning every indexed document

### Requirement: Repair hydration SHALL be bounded and faithful
Repair from the vector store SHALL reuse transactional page hydration, yield between pages, and preserve all recoverable lifecycle and provenance metadata.

#### Scenario: Repair is interrupted after several pages
- **WHEN** the process stops before repair completes
- **THEN** completed pages remain valid and a later invocation can continue without duplicating or corrupting rows

### Requirement: Import SHALL cap amplification
Import SHALL enforce a maximum chunk count and per-chunk size, batch provider work where supported, and reject oversized input with the offending bound before creating permanently unsyncable rows.

#### Scenario: Freeform input produces excessive tiny chunks
- **WHEN** parsing would exceed the configured import chunk limit
- **THEN** import returns invalid input with the observed count and configured maximum

### Requirement: Consolidation discovery SHALL use bounded concurrency and deadlines
Neighbor discovery SHALL process a configured number of queries concurrently and return progress or a continuation cursor when the per-call deadline is reached.

#### Scenario: Consolidation scans the maximum page
- **WHEN** hundreds of candidates require neighbor queries
- **THEN** the system avoids both strictly serial execution and unbounded fan-out

### Requirement: Tool and resource responses SHALL honor a character budget
Response-producing surfaces SHALL enforce the configured maximum serialized content budget and indicate truncation or continuation.

#### Scenario: Search matches many large memories
- **WHEN** the full response would exceed `defaults.max_response_chars`
- **THEN** returned data stays within the budget and identifies truncation or a continuation path
