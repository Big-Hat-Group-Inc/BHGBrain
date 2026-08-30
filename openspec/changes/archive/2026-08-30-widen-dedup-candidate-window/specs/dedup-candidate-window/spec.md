## ADDED Requirements

### Requirement: Dedup classification SHALL evaluate a window of similarity candidates
The write pipeline's dedup classifier SHALL evaluate up to `deduplication.candidate_window`
of the fetched near-neighbor candidates (sorted descending by score), not only the
single closest one, when deciding whether an otherwise-below-threshold candidate should
still classify as `UPDATE`.

#### Scenario: Corroborated near-duplicate cluster yields UPDATE
- **WHEN** a candidate's closest match scores below the tier's UPDATE threshold
- **AND** at least `deduplication.corroboration_count` candidates within the evaluated
  window (including the closest) score at or above
  `UPDATE threshold - deduplication.corroboration_margin`
- **THEN** the pipeline SHALL classify `UPDATE`, targeting the highest-scoring
  candidate in the window

#### Scenario: Uncorroborated below-threshold candidate yields ADD
- **WHEN** a candidate's closest match scores below the tier's UPDATE threshold
- **AND** fewer than `deduplication.corroboration_count` candidates in the evaluated
  window score at or above `UPDATE threshold - deduplication.corroboration_margin`
- **THEN** the pipeline SHALL classify `ADD`, unchanged from single-candidate behavior

#### Scenario: NOOP and DELETE remain governed by the single closest candidate
- **WHEN** the closest candidate's score independently clears the tier's NOOP threshold,
  or clears the UPDATE threshold with an invalidation-worded candidate
- **THEN** the pipeline SHALL classify `NOOP` or `DELETE` exactly as it does today,
  evaluated only against the closest candidate, unaffected by window size or
  corroboration configuration

### Requirement: Candidate-window evaluation SHALL be configurable and independently disableable
The window size and corroboration parameters SHALL come from validated configuration,
and disabling corroboration SHALL restore single-candidate (`similar[0]`-only)
classification without disabling deduplication as a whole.

#### Scenario: Operator disables corroboration
- **WHEN** `deduplication.corroboration_enabled` is `false`
- **THEN** dedup classification SHALL consider only the single closest candidate for
  every decision, identical to pre-widening behavior, regardless of
  `deduplication.candidate_window`, `corroboration_count`, or `corroboration_margin`

#### Scenario: Window size bounds evaluated candidates
- **WHEN** `deduplication.candidate_window` is set to a value `N`
- **THEN** the classifier SHALL evaluate at most the top `N` candidates from the
  fetched similarity results for corroboration, ignoring any candidates ranked beyond
  position `N`

### Requirement: A corroborated merge decision SHALL be observable
When the corroboration path selects `UPDATE` for a candidate that did not
independently clear the UPDATE threshold, the pipeline SHALL emit a structured warning
log identifying the event, so operators can monitor and tune the behavior.

#### Scenario: Corroboration trigger emits a structured log
- **WHEN** the pipeline classifies `UPDATE` via the corroboration path
- **THEN** it SHALL emit a warning log with a `corroborated_dedup` event identifying
  the target memory id
- **AND** no such log SHALL be emitted for decisions resolved via the single-candidate
  path (NOOP, DELETE, direct UPDATE, or ADD with no corroboration)
