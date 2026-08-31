## ADDED Requirements

### Requirement: Callers SHALL be able to record usefulness feedback for a recalled memory
The system SHALL provide a `feedback` MCP tool accepting a memory `id`, a boolean
`useful` verdict, and optional `query`/`score` context, and SHALL persist each call as
an event.

#### Scenario: Recording feedback for an existing memory
- **WHEN** `feedback` is called with `id` referencing an active memory and `useful:
  true`
- **THEN** the call SHALL succeed and return the memory `id`, the recorded `useful`
  value, and a `recorded_at` timestamp

#### Scenario: Recording negative feedback
- **WHEN** `feedback` is called with `useful: false`
- **THEN** the call SHALL succeed and the event SHALL be persisted with `useful: false`,
  distinguishable from a `useful: true` event for the same memory

#### Scenario: Optional context is carried through when provided
- **WHEN** `feedback` is called with `query` and/or `score` set
- **THEN** those values SHALL be persisted alongside the event unmodified and
  unvalidated against any prior `recall`/`search` call

#### Scenario: Optional context is omitted
- **WHEN** `feedback` is called without `query` or `score`
- **THEN** the persisted event SHALL record them as absent rather than defaulting to a
  fabricated value

#### Scenario: Feedback for a nonexistent or archived memory
- **WHEN** `feedback` is called with an `id` that does not match any active memory
  (including an `id` that exists only in the archive)
- **THEN** the call SHALL fail with `NOT_FOUND` and no event SHALL be persisted

### Requirement: Feedback events SHALL be an append-only stream independent of the referenced memory
Recording feedback SHALL NOT mutate the referenced memory's stored fields (including
`access_count`, `importance`, or any ranking-relevant field), and multiple feedback
events for the same memory SHALL each be retained individually rather than collapsed
into a running total.

#### Scenario: Multiple feedback events for one memory
- **WHEN** `feedback` is called more than once for the same memory `id`, with
  different `useful` verdicts across calls
- **THEN** every call SHALL persist as a distinct event
- **AND** none of the calls SHALL overwrite or delete an earlier event for that memory

#### Scenario: Feedback does not alter the memory record
- **WHEN** `feedback` is called for a memory
- **THEN** the memory's own row (including `access_count`, `importance`,
  `retention_tier`, `review_due`, and `updated_at`) SHALL be unchanged as a result of
  that call

### Requirement: Feedback collection SHALL have no effect on ranking, lifecycle, or search behavior in this version
Recorded feedback events SHALL NOT influence composite ranking (`search.ranking`),
tier promotion or decay, dedup thresholds, or any `recall`/`search`/`review` result in
this version — they are collected for a future change to consume.

#### Scenario: Ranking is unaffected by recorded feedback
- **WHEN** feedback events exist for a memory, in any quantity or mix of `useful`
  values
- **THEN** that memory's composite ranking score and position in `recall`/`search`
  results SHALL be identical to what they would be with no feedback events recorded

#### Scenario: No read surface is added
- **WHEN** a caller wants to inspect recorded feedback
- **THEN** no `feedback`-reading MCP tool, resource, or aggregate field SHALL be
  provided by this version — recorded events are inert until a future change adds
  analysis
