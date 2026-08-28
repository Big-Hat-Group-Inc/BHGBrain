## ADDED Requirements

### Requirement: UPDATE-band writes SHALL be optionally checked for semantic contradiction
When `pipeline.contradiction_detection.enabled` is true and a candidate's top
similarity match falls within the tier's UPDATE band without triggering the existing
regex-based invalidation check, the write pipeline SHALL classify the relationship
between the candidate and the matched memory as `agree`, `refine`, or `contradict` via
an LLM entailment call, and SHALL route `contradict` to the same DELETE-and-replace
path used by regex-triggered invalidation.

#### Scenario: Regex fast path takes priority over the LLM check
- **WHEN** a candidate's content matches one of the existing `detectsInvalidation`
  patterns (e.g. "no longer", "correction:")
- **AND** its top similarity score is at or above the UPDATE threshold
- **THEN** the pipeline SHALL return `DELETE` without invoking the LLM entailment
  check

#### Scenario: LLM classifies a same-topic write as contradictory
- **WHEN** `pipeline.contradiction_detection.enabled` is true
- **AND** a candidate's top similarity score falls within the UPDATE band
- **AND** the candidate does not match any `detectsInvalidation` pattern
- **AND** the entailment check classifies the candidate as `contradict` relative to
  the matched memory
- **THEN** the pipeline SHALL delete the matched memory and store the candidate as a
  new memory referencing it via `merged_from`, identical in shape to a regex-triggered
  `DELETE`

#### Scenario: LLM classifies a same-topic write as agreement or refinement
- **WHEN** `pipeline.contradiction_detection.enabled` is true
- **AND** a candidate's top similarity score falls within the UPDATE band
- **AND** the entailment check classifies the candidate as `agree` or `refine`
- **THEN** the pipeline SHALL proceed with the existing `UPDATE` merge behavior,
  unchanged from a store with contradiction detection disabled

### Requirement: Contradiction detection SHALL be disabled by default and SHALL fail open
The feature SHALL NOT alter write behavior unless explicitly enabled, and any failure
of the entailment call (error, timeout, or unusable response) SHALL fall back to the
pipeline's existing UPDATE-band behavior rather than blocking, delaying indefinitely,
or rejecting the write.

#### Scenario: Default configuration performs no LLM calls
- **WHEN** `pipeline.contradiction_detection.enabled` is left at its default (`false`)
- **THEN** the write pipeline SHALL make no entailment call for any candidate
- **AND** `detectsInvalidation` SHALL remain the only trigger capable of producing
  `DELETE`

#### Scenario: Entailment call failure falls back to UPDATE
- **WHEN** `pipeline.contradiction_detection.enabled` is true
- **AND** the entailment call errors, exceeds `timeout_ms`, or returns a response that
  is not one of `agree` / `refine` / `contradict`
- **THEN** the pipeline SHALL proceed as if the check had returned `agree` or `refine`
  (existing `UPDATE` behavior)
- **AND** the pipeline SHALL log a degraded-path event rather than surfacing an error
  to the caller

### Requirement: Contradiction-triggered deletes SHALL preserve existing lineage semantics
A `DELETE` reached via the LLM entailment check SHALL produce the same `WriteResult`
shape, `merged_from` linkage, and audit log entries as a `DELETE` reached via the
regex-based `detectsInvalidation` check, with no additional fields distinguishing the
two triggers.

#### Scenario: Contradiction-triggered delete matches regex-triggered delete shape
- **WHEN** a write is deleted-and-replaced via the LLM entailment check's `contradict`
  classification
- **THEN** the resulting `WriteResult` SHALL have `operation: 'DELETE'` and
  `merged_with_id` set to the deleted memory's id
- **AND** the new memory record SHALL have `merged_from` set to the deleted memory's
  id and `last_operation: 'DELETE'`
- **AND** an audit log entry SHALL be recorded for the `DELETE` and a separate entry
  for the subsequent `ADD`, matching the existing regex-triggered path
