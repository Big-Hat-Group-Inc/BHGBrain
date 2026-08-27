## ADDED Requirements

### Requirement: Fulltext search SHALL use an FTS5 index with stemming and BM25
Fulltext matching SHALL run against an FTS5 virtual table with porter stemming, ranked
by BM25 with summary and tags weighted above body content, preserving the ordering
contract consumed by hybrid fusion.

#### Scenario: Morphological variant query
- **WHEN** a memory contains "deployment pipeline"
- **AND** a fulltext search queries "deployed"
- **THEN** the memory SHALL be returned

#### Scenario: Ranking respects field weights and length normalization
- **WHEN** one memory matches the query in its summary and another matches only deep
  in a long body
- **THEN** the summary match SHALL rank first

### Requirement: The FTS index SHALL be derived, migrated, and rebuildable
The FTS5 table SHALL be backfilled from existing memories on first startup after
upgrade, maintained on every memory write/delete/archive path, and rebuildable from
the `memories` table at any time.

#### Scenario: Upgrade from the legacy plain table
- **WHEN** the server starts against a database with the legacy fulltext table
- **THEN** the FTS5 table SHALL be created and backfilled in batches
- **AND** the migration SHALL be idempotent across restarts and interruptions

### Requirement: Missing FTS5 support SHALL degrade gracefully and visibly
When the SQLite build lacks FTS5, fulltext SHALL fall back to the legacy
implementation, and the condition SHALL be visible in health output and logs.

#### Scenario: Probe fails at startup
- **WHEN** the FTS5 capability probe fails
- **THEN** fulltext queries SHALL be served by the legacy path
- **AND** the sqlite health component SHALL carry a message describing the fallback

### Requirement: User queries SHALL be inert in MATCH syntax
Query strings SHALL be sanitized into literal tokens so FTS5 operators in user input
cannot alter query semantics or raise syntax errors.

#### Scenario: Query containing FTS5 operators
- **WHEN** a fulltext query contains characters such as quotes, asterisks, or NEAR
- **THEN** the search SHALL treat them as literal text and SHALL NOT error
