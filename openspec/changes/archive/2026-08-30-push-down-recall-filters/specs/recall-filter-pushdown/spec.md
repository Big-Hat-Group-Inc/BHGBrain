## ADDED Requirements

### Requirement: Recall filters SHALL be applied in the storage layer
Type and tag filters on recall SHALL be evaluated inside the vector and fulltext
stores so that the result limit counts matching memories, not unfiltered candidates.

#### Scenario: Matching memories exist below the unfiltered top-K
- **WHEN** a recall specifies `type` (or `tags`) and `limit` N
- **AND** fewer than N of the globally top-N candidates match, but at least N matching
  memories exist in the store
- **THEN** the recall SHALL return up to N matching memories
- **AND** it SHALL NOT return zero results merely because non-matching memories ranked
  higher

#### Scenario: No filter provided
- **WHEN** a recall provides no type or tag filter
- **THEN** results SHALL be identical to the pre-change behavior

### Requirement: min_score SHALL apply to the score field it was calibrated for
The recall `min_score` threshold SHALL be applied to the cosine-similarity
(`semantic_score`) field, and its schema documentation SHALL state this.

#### Scenario: Threshold applied to cosine similarity
- **WHEN** recall filters results by `min_score`
- **THEN** the comparison SHALL use the cosine-similarity score, not a fused or
  boost-adjusted score
- **AND** a test SHALL fail if the threshold is ever applied to a score in a different
  range

### Requirement: Residual post-filtering SHALL be observable
Any post-retrieval filtering that removes store-returned results SHALL increment a
metric so filter starvation is visible to operators.

#### Scenario: Defensive re-check removes a result
- **WHEN** the defensive post-retrieval re-check removes one or more results
- **THEN** a `recall_zero_after_filter`-style counter SHALL be incremented
