# Spec: new-device-bootstrap-hydration

## ADDED Requirements

### Requirement: Hydration SHALL be atomic per memory

When hydrating a memory from a Qdrant payload into local SQLite, the system SHALL
treat the `memories` insert and the corresponding `memories_fts` insert as a single
atomic unit. A failure to persist the `memories` row SHALL NOT leave an orphan
`memories_fts` row, SHALL NOT count the memory as hydrated, and SHALL NOT cause the
hydration routine to report success for that memory.

This requirement exists because a silently-dropped row with a surviving FTS entry
recreates the exact cross-device silent-drop failure mode this capability was created
to eliminate: full-text search returns an id that `getMemoryById` cannot load.

#### Scenario: Payload with a constraint-violating `type` does not leave an orphan FTS row

- **GIVEN** a Qdrant payload whose `type` field is a string outside the allowed set
  `{episodic, semantic, procedural}` (the `memories.type` CHECK constraint)
- **WHEN** the payload is hydrated via `upsertMemoryFromPayload` / `bootstrapFromQdrant`
- **THEN** the row SHALL either be normalized to the documented default `type` of
  `semantic` and persisted to `memories` (and only then indexed in `memories_fts`),
  **OR** the hydration SHALL fail loudly for that memory
- **AND** no orphan `memories_fts` row SHALL exist without a backing `memories` row
- **AND** the reported hydrated count SHALL reflect only memories actually persisted to
  `memories` (the count SHALL NOT be inflated by dropped rows)
- **AND** the memory SHALL NOT be silently dropped while reporting success.

#### Scenario: Constraint violation fails loudly rather than silently

- **GIVEN** a payload that, after `type` validation, would still violate a SQLite CHECK
  or NOT NULL constraint on `memories`
- **WHEN** the hydration insert is attempted
- **THEN** the insert SHALL surface the error (loud failure) rather than being swallowed
  by `INSERT OR IGNORE`
- **AND** the accompanying `memories_fts` insert SHALL NOT be applied for that memory.

## MODIFIED Requirements

### Requirement: `repair --from-qdrant` device-scoping contract SHALL align with device-namespace-partitioning

The `repair` hydration contract SHALL be single-sourced with the
`device-namespace-partitioning` capability so the two changes do not give the `repair`
surface contradictory device-scoping behavior. Either `bootstrapFromQdrant` and the
CLI `repair --from-qdrant` SHALL accept an optional `device_id` scope (defaulting to the
current `config.device.id`, with `--all-devices` to hydrate every device), OR the
unfiltered hydration SHALL be formally delegated to this command and the
`device-namespace-partitioning` spec updated so the `repair` contract is unambiguous
across both changes.

#### Scenario: Default repair scope matches the partitioning contract

- **GIVEN** a configured `config.device.id`
- **WHEN** `repair --from-qdrant` is invoked without `--all-devices`
- **THEN** the resulting hydration scope SHALL match the device-scoping contract defined
  by `device-namespace-partitioning` (no divergence between the two capabilities)
- **AND** `--all-devices` SHALL hydrate memories across every device.
