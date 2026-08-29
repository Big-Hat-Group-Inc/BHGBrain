## ADDED Requirements

### Requirement: Scheduled distillation SHALL consolidate clusters of related T2/T3 episodic memories into one T1 semantic memory
On a configurable cron schedule, the system SHALL group same-namespace,
same-collection, `T2`/`T3`, `episodic` memories into clusters by vector similarity,
and — for clusters meeting the configured size bounds — produce a single `T1`
`semantic` memory summarizing the cluster via an LLM call.

#### Scenario: A qualifying cluster is distilled
- **WHEN** three or more `episodic` memories in the same namespace and collection,
  tiered `T2` or `T3`, have pairwise cosine similarity at or above the configured
  threshold
- **THEN** the scheduled job SHALL call the distillation LLM client with their
  contents
- **AND** SHALL write one new memory with `type: semantic`, `retention_tier: T1`,
  and `derived_from` naming the source memory ids

#### Scenario: A cluster below the minimum size is not distilled
- **WHEN** a group of similar memories has fewer members than
  `retention.distillation.min_cluster_size`
- **THEN** the job SHALL NOT call the LLM client or write a distilled memory for
  that group

#### Scenario: Only T2/T3 episodic memories are eligible sources
- **WHEN** the clustering pass scans a namespace/collection
- **THEN** `T0`/`T1` memories and non-`episodic` memories SHALL be excluded from
  clustering regardless of vector similarity

### Requirement: Distillation sources SHALL be archived only after the distilled memory is durably written
The system SHALL NOT archive or delete any source memory in a cluster until the
consolidated replacement memory has been successfully written.

#### Scenario: Distilled write succeeds
- **WHEN** the consolidated memory is written successfully
- **THEN** each source memory in the cluster SHALL be archived and then removed via
  the existing archive-before-delete path
- **AND** a `DISTILL` lifecycle audit entry SHALL be recorded referencing the new
  memory id and the archived source ids

#### Scenario: LLM call fails or no extraction API key is configured
- **WHEN** the distillation LLM client cannot produce a consolidated draft for a
  cluster (missing key, request failure, or unparseable response)
- **THEN** the cluster SHALL be skipped
- **AND** no source memory in that cluster SHALL be archived, deleted, or otherwise
  modified
- **AND** the skip SHALL be counted and logged with a reason

#### Scenario: Archival fails after a successful distilled write
- **WHEN** the consolidated memory was written successfully but archiving one or
  more source memories fails
- **THEN** the distilled memory SHALL remain in place
- **AND** the affected source memories SHALL remain active and unmodified
- **AND** the run SHALL be marked degraded

### Requirement: Distillation SHALL be disabled by default and configurable
`retention.distillation.enabled` SHALL default to `false`. When enabled, the
scheduled distillation job's cadence and clustering thresholds SHALL come from
validated configuration.

#### Scenario: Distillation is not configured
- **WHEN** `retention.distillation.enabled` is `false` (the default)
- **THEN** no distillation scheduler SHALL run and no memory SHALL be clustered,
  distilled, or archived by this feature

#### Scenario: A dry run previews clusters without side effects
- **WHEN** distillation is run with `dryRun: true` (via the CLI `--dry-run` flag)
- **THEN** the system SHALL report the clusters that would be distilled
- **AND** SHALL NOT call the LLM client, write any memory, or archive any source

### Requirement: Distilled memories SHALL carry lineage to their source memories
Every memory produced by distillation SHALL record which source memories it was
derived from.

#### Scenario: A distilled memory's lineage is queryable
- **WHEN** a memory was produced by the distillation job
- **THEN** its `derived_from` field SHALL list the ids of the source memories it
  replaced

#### Scenario: Ordinary writes carry no lineage
- **WHEN** a memory is written through any path other than distillation
- **THEN** its `derived_from` field SHALL be `null`

### Requirement: A re-forming cluster SHALL update the prior distilled memory instead of duplicating it
When a later distillation run produces a consolidated draft that is highly similar
to an existing distilled memory, the write SHALL go through the standard dedup
decision path rather than always creating a new memory.

#### Scenario: Repeated distillation of an overlapping cluster
- **WHEN** a distillation run's consolidated draft is near-duplicate to a prior
  distilled memory (per the existing similarity-based UPDATE threshold)
- **THEN** the prior distilled memory SHALL be updated in place
- **AND** a duplicate T1 memory SHALL NOT be created
