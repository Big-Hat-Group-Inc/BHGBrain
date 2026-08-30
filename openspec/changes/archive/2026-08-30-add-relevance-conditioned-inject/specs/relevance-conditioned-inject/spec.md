## ADDED Requirements

### Requirement: Inject SHALL support relevance conditioning via a hint
A parameterized inject resource SHALL select its memory section by hybrid relevance to
a caller-provided hint, with recency selection retained as the hintless fallback.

#### Scenario: Hint provided
- **WHEN** a client reads the inject resource with a hint
- **THEN** the memory section SHALL contain the top-K memories by hybrid relevance to
  the hint, subject to expiry filtering
- **AND** access SHALL be recorded for the selected memories

#### Scenario: No hint
- **WHEN** a client reads the static inject resource
- **THEN** selection SHALL follow the existing recency behavior unchanged

#### Scenario: Embedding provider unavailable
- **WHEN** a hinted inject is requested while embeddings are down
- **THEN** selection SHALL degrade to the fulltext leg and the payload SHALL still be
  produced

### Requirement: The memory section SHALL have a reserved budget share
Budget arithmetic SHALL reserve a configurable fraction of the inject budget for
memories so category content cannot starve the memory section.

#### Scenario: Oversized categories
- **WHEN** category content alone would consume the entire budget
- **THEN** categories SHALL be truncated at their share and the memory section SHALL
  receive at least its reserved fraction

### Requirement: The budget unit SHALL be configurable
The inject budget SHALL be expressible in characters (default, byte-compatible with
current behavior) or estimated tokens, applied consistently across all sections.

#### Scenario: Token-estimated budgeting
- **WHEN** the budget unit is set to tokens
- **THEN** all sections and truncation flags SHALL be computed against the token
  estimate

### Requirement: Injected memories SHALL be near-duplicate suppressed
When enabled, the memory section SHALL NOT include two memories whose similarity
exceeds the configured deduplication threshold.

#### Scenario: Two near-identical memories rank in the top K
- **WHEN** two candidates exceed the similarity threshold with respect to each other
- **THEN** only the higher-ranked one SHALL be injected and the freed budget SHALL go
  to the next distinct candidate
