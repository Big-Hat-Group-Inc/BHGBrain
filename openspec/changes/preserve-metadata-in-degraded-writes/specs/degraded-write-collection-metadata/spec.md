## ADDED Requirements

### Requirement: Degraded writes must preserve collection metadata
When embedding generation is unavailable and fallback storage is enabled, the system SHALL still create or validate collection metadata for the target namespace and collection.

#### Scenario: Fallback write into a new collection
- **WHEN** degraded-mode fallback stores a memory in a collection that is not yet registered
- **THEN** the collection metadata is created with the configured embedding model and dimensions
- **THEN** the memory remains marked unsynced for later vector reconciliation

### Requirement: Degraded writes must preserve embedding compatibility checks
Fallback writes SHALL continue enforcing collection embedding-space compatibility.

#### Scenario: Fallback write targets incompatible collection metadata
- **WHEN** degraded-mode fallback targets a collection whose recorded model or dimensions differ from the active configuration
- **THEN** the write is rejected rather than silently persisting incompatible metadata
