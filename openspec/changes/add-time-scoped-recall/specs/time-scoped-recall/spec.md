## ADDED Requirements

### Requirement: `recall` and `search` SHALL accept optional creation-time bounds
Both tools SHALL accept optional `after` and `before` parameters as ISO 8601
timestamps, filtering results to memories whose `created_at` falls within the
requested (inclusive) window.

#### Scenario: Only `after` is provided
- **WHEN** a caller passes `after` without `before`
- **THEN** results SHALL include only memories with `created_at >= after`
- **AND** there SHALL be no upper bound on `created_at`

#### Scenario: Only `before` is provided
- **WHEN** a caller passes `before` without `after`
- **THEN** results SHALL include only memories with `created_at <= before`
- **AND** there SHALL be no lower bound on `created_at`

#### Scenario: Both bounds are provided
- **WHEN** a caller passes both `after` and `before`
- **THEN** results SHALL include only memories with `after <= created_at <= before`

#### Scenario: Neither bound is provided
- **WHEN** a caller omits both `after` and `before`
- **THEN** no creation-time filter SHALL be applied
- **AND** behavior SHALL be identical to `recall`/`search` calls made before this
  parameter existed

### Requirement: Creation-time bounds SHALL be validated before use
`after` and `before` SHALL be validated as ISO 8601 datetime strings, and a request
where `after` is later than `before` SHALL be rejected before any store is queried.

#### Scenario: Malformed timestamp
- **WHEN** `after` or `before` is not a valid ISO 8601 datetime string
- **THEN** the request SHALL be rejected with an input-validation error
- **AND** no store query SHALL be made

#### Scenario: Inverted window
- **WHEN** `after` is later than `before`
- **THEN** the request SHALL be rejected with an input-validation error
- **AND** no store query SHALL be made

### Requirement: Creation-time bounds SHALL be pushed down into the stores
The `after`/`before` predicate SHALL be applied inside the vector store (Qdrant) and
the fulltext store (SQLite) so that `limit` counts memories matching the time window,
not unfiltered top-K candidates that are later discarded.

#### Scenario: Filter starvation is avoided
- **WHEN** a namespace/collection contains more in-window matching memories than
  `limit`, positioned outside the store's default (unfiltered) top-`limit` ranking
- **THEN** a request with `after`/`before` set SHALL still return up to `limit`
  in-window matches
- **AND** SHALL NOT return fewer matches solely because out-of-window candidates
  consumed the candidate budget

#### Scenario: Semantic path filter shape
- **WHEN** `recall` (or `search` in `semantic`/`hybrid` mode) applies `after`/`before`
- **THEN** the Qdrant query SHALL include a range condition on the `created_at` payload
  field reflecting the requested bounds

#### Scenario: Fulltext path filter shape
- **WHEN** `search` in `fulltext`/`hybrid` mode applies `after`/`before`
- **THEN** the SQLite fulltext query SHALL include predicates on `created_at`
  reflecting the requested bounds

### Requirement: A defensive re-check SHALL guard against store/filter drift
Results SHALL be re-verified against the requested `after`/`before` window after
retrieval, and any result removed by this re-check (indicating the store-level filter
did not fully apply) SHALL be observable via a metric.

#### Scenario: Store already returned only in-window results
- **WHEN** the store's push-down filter correctly excluded all out-of-window
  candidates
- **THEN** the defensive re-check SHALL remove nothing
- **AND** the drift metric SHALL NOT increment

#### Scenario: Store returns an out-of-window result despite the filter
- **WHEN** the defensive re-check removes a result that violates the requested
  `after`/`before` window
- **THEN** the corresponding drift counter SHALL increment (`recall_zero_after_filter`
  for `recall`, `search_zero_after_filter` for `search`)
