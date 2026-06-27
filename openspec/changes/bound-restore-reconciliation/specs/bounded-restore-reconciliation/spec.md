## ADDED Requirements

### Requirement: Restore SHALL reconcile only actual vector drift
Restore SHALL reconcile only the memories whose vectors actually differ from or are missing in the vector store, and SHALL skip re-embedding memories whose vectors already match, instead of unconditionally clearing all vectors and re-embedding the entire dataset. When drift cannot be reliably determined (for example, the embedding model or dimensions changed), restore MAY fall back to a full rebuild.

#### Scenario: No-drift restore performs no re-embedding
- **WHEN** a restore activates SQLite metadata whose memories already have matching vectors in the vector store
- **THEN** restore reconciles without re-embedding any memory
- **AND** the vector store is not emptied of already-matching vectors
- **AND** the restore result reports vector reconciliation as reconciled

#### Scenario: Partial-drift restore re-embeds only the drifted subset
- **WHEN** a restore activates SQLite metadata where only some memories differ from the vector store
- **THEN** restore re-embeds and upserts only the differing or missing memories
- **AND** memories whose vectors already match are left untouched

#### Scenario: Indeterminate drift falls back to full rebuild
- **WHEN** restore cannot reliably determine drift because the embedding model or dimensions changed or vector state is missing or incompatible
- **THEN** restore performs a full rebuild of vectors from restored SQLite content

### Requirement: Post-restore reconciliation SHALL be bounded and SHALL NOT hold the lifecycle lock for the full re-embed
Post-restore reconciliation SHALL run under an overall timeout and an iteration/cap bound, and SHALL NOT hold the restore lifecycle lock for the duration of the full re-embed. Once SQLite activation completes, restore SHALL return promptly with explicit reconciling/pending status and continue any remaining reconciliation in a bounded, resumable background task.

#### Scenario: Slow embedding provider does not block the restore call
- **WHEN** a restore activates SQLite metadata and the embedding provider is slow or rate-limited
- **THEN** restore returns promptly reporting metadata activation success and vector reconciliation as reconciling or pending
- **AND** the restore lifecycle lock is not held for the full re-embedding duration
- **AND** reconciliation continues within a bounded timeout and iteration cap

#### Scenario: Bounded reconciliation resumes and completes
- **WHEN** background reconciliation runs after a restore returns reconciling
- **THEN** reconciliation processes the remaining unsynced memories within its bound
- **AND** semantic health transitions from reconciling to reconciled once reconciliation completes

### Requirement: Restore SHALL keep semantic search usable until a rebuild succeeds
Restore SHALL NOT destroy existing vectors before a replacement rebuild succeeds, or SHALL otherwise provide an auto-retry path or degraded signal so that a failed reconciliation does not leave semantic search blank with no recovery.

#### Scenario: Failed reconciliation does not leave search blank with no recovery
- **WHEN** post-restore reconciliation fails before producing a usable vector set
- **THEN** existing usable vectors are not destroyed ahead of a successful rebuild, or an auto-retry path resumes reconciliation
- **AND** semantic health reports a degraded signal rather than silently leaving search blank

### Requirement: Reconciliation progress SHALL be durable at batch granularity with idempotent replay
Reconciliation SHALL persist sync marks at batch granularity so that a hard crash loses at most one batch of progress, and SHALL guarantee that any progress lost to a hard crash is safely recovered by idempotent re-upsert on restart without duplicating data.

#### Scenario: Hard crash mid-reconciliation loses at most one batch
- **WHEN** the process is hard-killed during reconciliation after some batches have completed
- **THEN** sync marks for completed batches are durable
- **AND** at most one in-flight batch must be re-reconciled on restart
- **AND** restart resumes from the remaining unsynced set and re-upserts idempotently without duplicating data
