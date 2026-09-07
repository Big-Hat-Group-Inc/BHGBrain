## Purpose

Defines how SQLite, its full-text projection, and Qdrant remain recoverably consistent across memory mutations, model migration, and reconciliation failures.

## ADDED Requirements

### Requirement: Local memory projections SHALL change atomically
A logical insert, update, or delete SHALL commit the authoritative memory row, full-text projection, links, revisions, and audit state as one transaction wherever those records form one operation.

#### Scenario: Full-text maintenance fails during an update
- **WHEN** full-text projection maintenance fails after a memory update begins
- **THEN** the authoritative memory and its prior full-text projection remain unchanged
- **AND** no committed memory becomes permanently absent from full-text search

#### Scenario: Memory deletion includes relationships
- **WHEN** a memory or collection is deleted successfully
- **THEN** links referring to deleted memories are removed in the same local transaction

### Requirement: Cross-store deletion SHALL fail into a detectable recoverable state
Single and batched deletion SHALL order or stage work so a failure cannot leave a surviving SQLite row marked synchronized after its vector has been removed.

#### Scenario: SQLite deletion fails after vector cleanup
- **WHEN** vector deletion succeeds but local deletion cannot commit
- **THEN** the surviving memory is marked as unreconciled using a lifecycle-authorized compensation
- **AND** the operation reports a degraded result identifying the affected memory

#### Scenario: Vector deletion fails
- **WHEN** vector deletion cannot be confirmed
- **THEN** authoritative local data remains available
- **AND** the failure cause and retryable drift are visible to the caller and health reporting

### Requirement: Compensation SHALL preserve the primary failure
Rollback and tombstone operations SHALL be permitted during their owning lifecycle operation and SHALL never replace the primary error with a compensation error.

#### Scenario: Compensation also fails
- **WHEN** a primary cross-store mutation fails and its compensation fails
- **THEN** the caller receives the primary failure
- **AND** both failures are emitted as a structured consistency event

### Requirement: Vector payloads SHALL reflect authoritative metadata
Metadata that affects filtering, expiry, retention, access, review, or provenance SHALL converge from SQLite into the corresponding vector payload even when content and embedding values are unchanged.

#### Scenario: Access or lifecycle metadata changes
- **WHEN** a metadata-only operation changes a field used by vector filtering or ranking
- **THEN** the corresponding vector payload is refreshed or marked for reconciliation

### Requirement: Embedding migration SHALL converge collection identity
A successful re-embedding pass SHALL update both memory-level vectors and the collection's expected embedding identity before normal writes resume.

#### Scenario: Existing collection is re-embedded
- **WHEN** all targeted memories converge to the active embedding identity
- **THEN** the collection metadata adopts that identity
- **AND** subsequent compatible writes are accepted

### Requirement: Reconciliation SHALL isolate poison records and support resume
Reconciliation SHALL process bounded ID batches, continue past per-memory permanent failures, classify those failures distinctly from transient backlog, and expose an operator command or cursor that resumes remaining work.

#### Scenario: One memory cannot be embedded
- **WHEN** one memory in a reconciliation page causes a permanent provider rejection
- **THEN** that memory is reported as permanently failed
- **AND** other memories in the page and later pages continue to reconcile

#### Scenario: Drift set exceeds the database parameter limit
- **WHEN** a repair or restore identifies tens of thousands of drifted IDs
- **THEN** sync markers are updated in bounded transactional chunks

### Requirement: Required vector indexes SHALL be idempotently ensured
All fields used for vector filtering, including tags and lifecycle metadata, SHALL have their payload indexes checked on an existing or newly created collection and retried after partial setup failure.

#### Scenario: Collection creation succeeds but index creation fails
- **WHEN** a later operation reuses the existing collection
- **THEN** missing required payload indexes are created before the collection is marked ensured
