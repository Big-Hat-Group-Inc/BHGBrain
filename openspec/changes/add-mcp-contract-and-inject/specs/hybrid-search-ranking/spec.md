## ADDED Requirements

### Requirement: Search SHALL support semantic fulltext and hybrid modes
The `search` tool SHALL support `semantic`, `fulltext`, and `hybrid` modes with a default of `hybrid`.

#### Scenario: Semantic mode returns vector-ranked results
- **WHEN** `search` is called with mode `semantic`
- **THEN** results are ranked by semantic similarity score

#### Scenario: Fulltext mode returns lexical-ranked results
- **WHEN** `search` is called with mode `fulltext`
- **THEN** results are ranked by fulltext relevance score

### Requirement: Hybrid mode SHALL use Reciprocal Rank Fusion
In hybrid mode, the system SHALL combine semantic and fulltext rankings with Reciprocal Rank Fusion using configurable weights.

#### Scenario: Hybrid response includes blended ranking details
- **WHEN** `search` is called with mode `hybrid`
- **THEN** each result includes overall score plus semantic and fulltext score components

#### Scenario: Configured hybrid weights influence ranking
- **WHEN** `search.hybrid_weights` is updated in configuration
- **THEN** hybrid result ordering reflects the configured semantic and fulltext weight balance
