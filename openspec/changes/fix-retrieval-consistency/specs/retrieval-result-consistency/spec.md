## Purpose

Defines shared eligibility, budgeting, query parsing, scoring, and ordering semantics across search, recall, linked expansion, injection, archive lookup, and consolidation.

## ADDED Requirements

### Requirement: Expiry SHALL be enforced on every active read surface
Expired memories SHALL be excluded from semantic, full-text, linked, pinned, injected, collection, and direct active-memory results using the same clock semantics.

#### Scenario: Expired memory is pinned or linked
- **WHEN** an expired memory is pinned or linked from an active result
- **THEN** recall and session injection do not return its content as active memory

### Requirement: Requested archived results SHALL receive an explicit budget
When archived lookup is enabled, matching archived results SHALL be returned according to a documented active and archive budget and SHALL NOT disappear solely because active results filled the ordinary limit.

#### Scenario: Active results fill the limit
- **WHEN** active matches equal or exceed the requested limit and archived matches also exist
- **THEN** the response includes archived matches under the archived-result contract

### Requirement: Full-text query tokens SHALL be safe and meaningful
Operator syntax, LIKE wildcards, punctuation-only terms, and emoji-only terms SHALL NOT alter query structure or zero otherwise meaningful terms; a query with no indexable terms SHALL match nothing explicitly.

#### Scenario: Query mixes words and punctuation
- **WHEN** a query contains searchable words plus punctuation-only tokens
- **THEN** the searchable words remain effective and punctuation is ignored safely

#### Scenario: Archive query contains percent or underscore
- **WHEN** a caller searches archived memories for `%` or `_`
- **THEN** those characters are treated literally and cannot enumerate the archive

### Requirement: Ranking SHALL preserve relevance information and determinism
Full-text normalization SHALL remain monotonic across observed BM25 ranks, and all score sorts that determine membership SHALL apply a stable memory-ID tie-breaker.

#### Scenario: Equal-score results cross a slice boundary
- **WHEN** candidates have equal scores at the result cutoff
- **THEN** repeated requests select the same candidates in memory-ID order

### Requirement: Reranked and unranked populations SHALL remain ordered by evaluation status
Candidates evaluated by the reranker SHALL be ordered within the reranked pool, and candidates outside that pool SHALL NOT overtake them by comparing scores from incompatible scales.

#### Scenario: Out-of-pool composite score exceeds a rerank score
- **WHEN** an unranked candidate has a numerically larger composite score than a reranked candidate's judgment score
- **THEN** the unranked candidate remains after the evaluated pool

### Requirement: Result limits SHALL count eligible memories
Search SHALL fetch or filter deeply enough that expired rows do not cause a response to under-return while eligible matches remain available.

#### Scenario: Highest full-text matches are expired
- **WHEN** expired rows occupy initial full-text positions and live matches exist after them
- **THEN** the result is backfilled with live matches up to the requested limit

### Requirement: Consolidation partial failure SHALL remain accurate and diagnosable
A merge SHALL record only successfully incorporated and deleted sources in final lineage or explicitly mark pending sources, and each failed source SHALL retain a structured reason.

#### Scenario: One source delete fails during merge
- **WHEN** other sources merge successfully but one source cannot be removed
- **THEN** the response and logs identify that source and its cause
- **AND** lineage does not imply an unqualified completed merge for it
