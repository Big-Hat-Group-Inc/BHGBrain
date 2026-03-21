## ADDED Requirements

### Requirement: Restore SHALL make vector consistency explicit
When a restore activates SQLite state, the system SHALL also report whether Qdrant vector state is already reconciled, actively reconciling, or still pending reconciliation.

#### Scenario: Restore response distinguishes activation from reconciliation
- **WHEN** a restore operation successfully activates restored SQLite bytes in the running process
- **THEN** the restore result reports metadata activation success
- **AND** the result also reports the post-restore vector consistency state instead of implying semantic readiness automatically

### Requirement: Restored metadata SHALL not silently trust pre-existing vector state
After restore, the system SHALL not assume that previously existing Qdrant vectors match the restored SQLite dataset unless reconciliation has explicitly confirmed or rebuilt that state.

#### Scenario: Older SQLite restore invalidates newer vector assumptions
- **WHEN** an operator restores SQLite data from an earlier backup while Qdrant still contains vectors from a newer state
- **THEN** the system marks vector consistency as unreconciled
- **AND** semantic health does not report the service as fully ready until reconciliation completes

### Requirement: Restore reconciliation SHALL rebuild vectors from restored SQLite content
The system SHALL provide a reconciliation path that re-upserts vectors from restored SQLite rows and updates sync state as each restored memory is brought back into semantic readiness.

#### Scenario: Reconciliation rebuilds vectors after restore
- **WHEN** restore finishes with unreconciled vector state and embeddings are available
- **THEN** the reconciliation flow reads restored memories from SQLite
- **AND** it upserts vectors into the correct Qdrant collections
- **AND** it updates each memory's vector sync state as reconciliation succeeds

#### Scenario: Restore remains explicitly degraded when embeddings are unavailable
- **WHEN** restore finishes but the embedding provider is unavailable for reconciliation
- **THEN** restored SQLite data remains active
- **AND** semantic readiness remains in a degraded or pending state
- **AND** health reporting indicates that vector reconciliation is still required
