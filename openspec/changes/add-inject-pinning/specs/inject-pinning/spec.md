## ADDED Requirements

### Requirement: Memories SHALL support a settable `pinned` flag
`MemoryRecord` SHALL carry a `pinned` boolean, defaulting to `false`, settable
via the `remember` and `tag` tools.

#### Scenario: Setting pinned on a new memory
- **WHEN** `remember` is called with `pinned: true`
- **THEN** the created memory SHALL have `pinned: true`

#### Scenario: Omitting pinned preserves it across a remember UPDATE
- **WHEN** an existing pinned memory is updated via `remember`'s dedup UPDATE
  path without a `pinned` field in the input
- **THEN** the memory SHALL remain pinned

#### Scenario: Explicit pinned overrides on a remember UPDATE
- **WHEN** an existing pinned memory is updated via `remember`'s dedup UPDATE
  path with `pinned: false` in the input
- **THEN** the memory SHALL become unpinned

#### Scenario: Tag toggles pinned without touching content
- **WHEN** `tag` is called with `pinned: true` (or `false`) for a memory
- **THEN** the memory's `pinned` state SHALL change accordingly
- **AND** its `content` and `tags` SHALL be unaffected

### Requirement: Pinned memory count SHALL be capped per namespace
The number of memories pinned within a namespace SHALL NOT exceed
`defaults.pin_limit_per_namespace`.

#### Scenario: Pinning beyond the cap is rejected
- **WHEN** a `remember` or `tag` call would set `pinned: true` on a memory not
  already pinned, and the namespace already has `pin_limit_per_namespace`
  pinned memories
- **THEN** the call SHALL be rejected with `INVALID_INPUT`
- **AND** no memory's `pinned` state SHALL change as a result

### Requirement: Inject SHALL always include a namespace's pinned memories
Both `memory://inject` and `memory://inject/{hint}` SHALL include all of a
namespace's pinned, non-expired memories in the memory section, ahead of the
recency- or relevance-selected candidates, regardless of where those
candidates would otherwise rank.

#### Scenario: Hintless inject includes pinned memories
- **WHEN** `memory://inject` is read for a namespace with pinned memories
- **THEN** the memory section SHALL include those pinned memories
- **AND** they SHALL NOT need to be among the most recently created/updated
  memories to appear

#### Scenario: Hinted inject includes pinned memories
- **WHEN** `memory://inject/{hint}` is read for a namespace with pinned
  memories
- **THEN** the memory section SHALL include those pinned memories
- **AND** they SHALL NOT need to match the hint to appear

#### Scenario: A memory that is both pinned and independently selected appears once
- **WHEN** a pinned memory would also be selected by the recency or relevance
  algorithm for that template
- **THEN** it SHALL appear exactly once in the memory section

#### Scenario: Pinned inclusion can be disabled
- **WHEN** `auto_inject.pinned_enabled` is `false`
- **THEN** neither inject template SHALL apply the pinned-inclusion step
- **AND** both templates SHALL behave as if no memory were pinned

### Requirement: Pinned memories SHALL be exempt from near-duplicate suppression
Near-duplicate suppression within the injected memory set SHALL NOT remove a
pinned memory, and SHALL NOT be applied between a pinned memory and a
recency/relevance candidate.

#### Scenario: Two near-duplicate pinned memories are both injected
- **WHEN** two pinned memories exceed the configured similarity threshold
  with respect to each other
- **THEN** both SHALL appear in the memory section

#### Scenario: A pinned memory and a near-duplicate relevance candidate both appear
- **WHEN** a pinned memory and a separately relevance-selected candidate
  exceed the configured similarity threshold with respect to each other
- **THEN** the pinned memory SHALL appear
- **AND** the relevance-selected candidate SHALL also appear (not suppressed
  on account of the pinned memory)

### Requirement: Pinning SHALL NOT affect search, recall, or ranking
A memory's `pinned` state SHALL have no effect on `search`/`recall` result
membership, ordering, or `SearchResult` fields.

#### Scenario: Search/recall ordering is unaffected by pinning
- **WHEN** a memory's `pinned` state changes
- **THEN** its position in `search`/`recall` results for a given query SHALL
  be unchanged
- **AND** `SearchResult` SHALL NOT expose a `pinned` field

### Requirement: The inject guarantee is budget-bounded, not absolute
Pinned memories SHALL be attempted first within the memory section's existing
reserved budget share; if pinned content alone exceeds that share, the
existing truncation rules SHALL still apply.

#### Scenario: Oversized pinned content still truncates
- **WHEN** the total content of a namespace's pinned memories exceeds the
  memory section's reserved budget share
- **THEN** pinned memories SHALL be truncated per the existing per-item
  truncation rules
- **AND** the payload's `truncated` flag SHALL be `true`

### Requirement: Pinned state SHALL survive repair and cross-device sync
`pinned` SHALL be persisted to the Qdrant payload and restored by
`repair --mode from-qdrant` and the cross-device Qdrant-payload fallback
path.

#### Scenario: Repair from Qdrant restores pinned state
- **WHEN** a memory with `pinned: true` is rebuilt into SQLite via
  `repair --mode from-qdrant`
- **THEN** the rebuilt row SHALL have `pinned: true`
