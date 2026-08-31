## MODIFIED Requirements

### Requirement: Archived memories SHALL be findable via search
Search SHALL optionally include archived memories, matched on their retained summary
and tags by **query term**: the query SHALL be split on whitespace (lowercased, empty
tokens dropped), and an archived memory matches when **every** term is a
case-insensitive substring of its retained summary or of its tags. A query yielding
no terms SHALL match no archived memories. Matches remain appended after active
results, marked as archived, unranked, and never access-recorded.

#### Scenario: Multi-word query matches non-contiguous terms
- **WHEN** a search sets include_archived with the query "deployment functional test"
- **AND** an archived memory's retained summary is "deployment note for the
  functional test"
- **THEN** that memory SHALL be returned marked as archived, even though the query
  never occurs in the summary as one contiguous substring

#### Scenario: Terms may be satisfied across summary and tags
- **WHEN** a search sets include_archived with a two-term query
- **AND** an archived memory's summary contains one term and its tags contain the
  other
- **THEN** that memory SHALL be returned marked as archived

#### Scenario: A query with an unmatched term does not match
- **WHEN** a search sets include_archived with a query containing at least one term
  found nowhere in an archived memory's retained summary or tags
- **THEN** that archived memory SHALL NOT be returned, regardless of how many other
  terms match

#### Scenario: Empty query matches nothing
- **WHEN** a search sets include_archived with an empty or whitespace-only query
- **THEN** no archived memories SHALL be returned (in particular, the archive SHALL
  NOT be returned wholesale)

#### Scenario: Excluded by default
- **WHEN** a search does not set include_archived
- **THEN** archived memories SHALL NOT appear in results
