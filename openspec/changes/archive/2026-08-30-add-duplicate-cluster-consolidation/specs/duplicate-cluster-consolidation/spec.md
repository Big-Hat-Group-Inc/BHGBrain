## ADDED Requirements

### Requirement: Near-duplicate clusters SHALL be discoverable in bounded, paginated pages
The system SHALL provide a `list` action that scans a single namespace/collection for
clusters of existing memories whose pairwise similarity meets a configurable threshold,
without performing a full O(n²) pairwise comparison and without persisting a report.

#### Scenario: Listing clusters in a namespace/collection
- **WHEN** a client lists duplicate clusters for a namespace and collection
- **THEN** memories connected by a similarity edge at or above the configured
  threshold SHALL be grouped into clusters
- **AND** clusters smaller than the requested minimum size SHALL be excluded
- **AND** each cluster SHALL include a suggested merge target that is a hint only

#### Scenario: Bounded scan cost
- **WHEN** a `list` call scans a namespace/collection larger than the configured
  per-call scan cap
- **THEN** the call SHALL process at most the capped number of memories
- **AND** SHALL return a cursor so a subsequent call can continue scanning
- **AND** neighbor discovery for each scanned memory SHALL use a bounded per-point
  similarity query rather than comparing it against every other memory in the store

### Requirement: Merging clusters SHALL require explicit human approval
The system SHALL provide a `merge` action that consolidates one or more explicitly
named source memories into one explicitly named target memory, and SHALL NOT merge
memories automatically or on a schedule.

#### Scenario: Explicit merge
- **WHEN** a client merges named source memory ids into a named target memory id
- **THEN** the target's tags SHALL become the union of its own tags and all sources'
  tags
- **AND** the target's importance SHALL become the maximum importance across the
  target and all sources
- **AND** the target's content and embedding SHALL remain unchanged
- **AND** each source SHALL be archived through the existing archive transition
  (vector removed, row moved to the archive, retained summary/tags/tier)

#### Scenario: Merge lineage is recorded
- **WHEN** a merge completes
- **THEN** the target's merge-lineage field SHALL reference every merged source id
- **AND** each archived source SHALL have an audit entry identifying it as a
  consolidation merge into the target

#### Scenario: No target/source overlap or cross-collection merge
- **WHEN** a merge request names the same id as both target and source, or names
  source ids belonging to a different namespace or collection than the target
- **THEN** the request SHALL be rejected without archiving anything

### Requirement: Partial merge failures SHALL be visible and safely retryable
If archiving a source fails partway through a merge, the system SHALL report which
sources succeeded and which failed, and SHALL NOT leave a source both archived and
not-deleted (or vice versa). Retrying a merge SHALL be safe.

#### Scenario: One source fails to archive
- **WHEN** a merge covering multiple sources fails to archive one of them
- **THEN** the sources that succeeded SHALL remain archived
- **AND** the failed source SHALL remain unarchived and live
- **AND** the response SHALL distinguish merged sources from failed ones

#### Scenario: Retrying a partially completed merge
- **WHEN** a merge is retried with a `source_ids` list that includes an
  already-archived id from a prior attempt
- **THEN** the already-archived id SHALL be skipped rather than causing the retry to
  fail
- **AND** the remaining, still-live sources SHALL be processed normally
