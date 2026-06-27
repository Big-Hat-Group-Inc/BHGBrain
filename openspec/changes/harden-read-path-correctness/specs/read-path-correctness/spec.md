## ADDED Requirements

### Requirement: Bulk-hydrated search results SHALL preserve ranking order under test
The ranking-order guarantee of bulk search hydration SHALL be verified by an automated test
that fails if results are returned in the underlying storage return order rather than the
ranked input order.

#### Scenario: Storage returns rows in a different order than the ranking
- **WHEN** the search layer hydrates a ranked list of memory IDs in bulk
- **AND** the bulk retrieval returns the corresponding rows in a different order than the
  ranked input
- **THEN** the assembled search results SHALL be ordered to match the ranked input order
- **AND** a test SHALL assert this ordering so a reordering regression fails CI

### Requirement: Auto-inject truncation SHALL honor the budget exactly across encodings
The auto-inject budget and truncation determination SHALL use consistent character-counting
semantics on both sides of the comparison, so the character budget is honored exactly and the
`truncated` flag is accurate, including for multibyte and astral-plane content.

#### Scenario: Category content near the budget boundary contains multibyte characters
- **WHEN** auto-inject assembles category content whose size approaches the character budget
- **AND** the content contains multibyte or astral-plane characters
- **THEN** the budget remaining and the "fully included" determination SHALL be computed in
  the same character-counting unit (not JS UTF-16 length versus SQLite character length)
- **THEN** content SHALL NOT exceed the budget and the `truncated` flag SHALL accurately
  reflect whether any category content was cut
- **AND** a test with multibyte content SHALL exercise the boundary

### Requirement: Batched access recording SHALL reuse a prepared statement
Read-path access metadata persistence SHALL update rows using a prepared statement reused
across rows, without rebuilding and re-parsing the SQL string on each row.

#### Scenario: A batch of access updates is recorded
- **WHEN** the read path records a batch of access-metadata updates
- **THEN** the updates SHALL be applied via a single prepared statement reused across the
  rows rather than a per-row statement prepared and freed each iteration
- **AND** the recorded values (access count, last-accessed, and any optional
  expires/retention/review fields) SHALL match the prior per-row behavior

### Requirement: Untrusted Qdrant payloads SHALL be validated before use
When a search result is reconstructed from a Qdrant payload in the cross-device fallback, the
payload fields SHALL be validated or narrowed before constructing the result, rather than
asserted with unchecked casts.

#### Scenario: A ranked ID misses local storage and is served from a Qdrant payload
- **WHEN** a ranked memory ID is absent from local storage but present in the Qdrant payload
- **THEN** each payload field used to build the search result SHALL be validated or narrowed
  (type-checked, element-checked for arrays, and membership-checked for enumerated fields)
  before use
- **AND** a missing or malformed field SHALL fall back to the established default rather than
  propagating an invalid value into the search result
- **AND** a test SHALL cover this fallback branch including a malformed-field case
