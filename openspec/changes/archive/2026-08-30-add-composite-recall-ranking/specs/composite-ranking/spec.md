## ADDED Requirements

### Requirement: Results SHALL be ordered by a composite of relevance and stored priors
Search and recall SHALL order results by relevance multiplied by a prior derived from
importance, access frequency, and tier-aware recency decay, with weights from
configuration.

#### Scenario: Signals differentiate equally relevant memories
- **WHEN** two memories have equal relevance scores
- **AND** one has higher importance, higher access count, or a more recent update
- **THEN** that memory SHALL rank first

#### Scenario: Tier-aware decay
- **WHEN** memories age without updates
- **THEN** T0 memories SHALL NOT decay
- **AND** lower tiers SHALL decay at configurable per-tier rates
- **AND** an UPDATE SHALL reset the memory's effective age

### Requirement: Composite ranking SHALL be configurable and disableable
The weights and decay rates SHALL come from validated configuration, and disabling the
feature SHALL restore pure-relevance ordering.

#### Scenario: Operator disables composite ranking
- **WHEN** `search.ranking.enabled` is false
- **THEN** ordering SHALL follow relevance scores alone

### Requirement: Raw scores and thresholds SHALL be unaffected
Composite ranking SHALL NOT alter the raw `semantic_score`/`fulltext_score` fields nor
the field the recall `min_score` threshold applies to.

#### Scenario: Threshold-filtered recall
- **WHEN** a recall applies `min_score`
- **THEN** result membership SHALL be identical regardless of ranking configuration
