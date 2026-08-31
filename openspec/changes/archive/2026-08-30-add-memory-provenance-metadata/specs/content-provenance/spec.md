## ADDED Requirements

### Requirement: Memories SHALL support optional content-origin metadata
A memory SHALL be able to record where its content came from — session, calling tool,
repository, and branch — separately from `source` (its origin category) and from
`embedding_model` (which embedding model produced its vector, tracked by
`embedding-provenance`).

#### Scenario: Caller supplies origin on remember
- **WHEN** `remember` is called with `origin: { session_id, tool, repo, branch }`
  (each field optional)
- **THEN** the memory SHALL persist the supplied `origin` fields
- **AND** `recall`, `search`, `memory://{id}`, and `memory://list` SHALL return that
  `origin` on the resulting memory

#### Scenario: Caller omits origin
- **WHEN** `remember` is called without `origin`
- **THEN** the memory SHALL persist `origin: null`
- **AND** no existing `remember` caller's behavior SHALL change as a result of this
  capability existing

#### Scenario: Unknown origin fields are rejected
- **WHEN** `remember` is called with an `origin` object containing a key other than
  `session_id`, `tool`, `repo`, or `branch`
- **THEN** the call SHALL fail with `INVALID_INPUT`

### Requirement: Memories SHALL carry a confidence score
Every memory SHALL have a `confidence` value in `[0, 1]` indicating how much to trust
its content, distinct from `importance` (how much the content matters).

#### Scenario: Caller supplies confidence explicitly
- **WHEN** `remember` is called with `confidence` in `[0, 1]`
- **THEN** the memory SHALL persist that exact value

#### Scenario: Confidence defaults by source when omitted
- **WHEN** `remember` is called without `confidence`
- **THEN** the memory SHALL receive the configured default for its `source`
  (`pipeline.default_confidence[source]`)
- **AND** the default for `agent`-sourced memories SHALL be lower than the default for
  `cli`- or `api`-sourced memories, reflecting "explicit user statement > agent
  inference"

#### Scenario: Out-of-range confidence is rejected
- **WHEN** `remember` is called with `confidence` outside `[0, 1]`
- **THEN** the call SHALL fail with `INVALID_INPUT`

### Requirement: UPDATE merges SHALL never lower confidence and SHALL preserve origin absent a replacement
When a `remember` call merges into an existing memory via the UPDATE dedup path, the
merge SHALL follow the same non-destructive precedent as `importance`.

#### Scenario: Confidence merge takes the higher value
- **WHEN** an UPDATE merge occurs between an existing memory and an incoming candidate
- **THEN** the merged memory's `confidence` SHALL be the maximum of the two values

#### Scenario: Origin is replaced only when supplied
- **WHEN** an UPDATE merge occurs and the incoming `remember` call supplies `origin`
- **THEN** the merged memory's `origin` SHALL be the incoming value

#### Scenario: Origin survives a merge with no incoming origin
- **WHEN** an UPDATE merge occurs and the incoming `remember` call supplies no `origin`
- **THEN** the merged memory's `origin` SHALL remain the existing value unchanged

### Requirement: Legacy memories SHALL read back with safe provenance defaults
A memory written before this capability existed SHALL NOT be treated as untrustworthy
or broken by its absence of `origin`/`confidence` data.

#### Scenario: Pre-existing row hydration
- **WHEN** a memory row written before this capability was added is read
- **THEN** its `origin` SHALL be `null`
- **AND** its `confidence` SHALL be `1.0`, not a lowered or missing value
