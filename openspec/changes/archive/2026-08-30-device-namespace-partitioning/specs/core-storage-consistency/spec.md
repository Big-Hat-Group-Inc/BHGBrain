## ADDED Requirements

### Requirement: Qdrant device_id index is ensured on existing collections

The system SHALL ensure a `device_id` keyword payload index exists on every Qdrant
collection it manages, including collections that **already exist** prior to this change
(the post-upgrade multi-device migration case). Index creation SHALL be idempotent: it
SHALL run on each `ensureCollection` call regardless of whether the collection was just
created or already existed, and an "already exists" conflict returned by Qdrant SHALL be
tolerated without error. Index creation SHALL NOT be confined to the
collection-not-found branch of `ensureCollection`.

#### Scenario: Index is created on an already-existing collection

- **GIVEN** a Qdrant collection that already exists (created before this change)
- **AND** the collection has no `device_id` payload index
- **WHEN** `ensureCollection` runs for that collection on startup
- **THEN** a `device_id` keyword payload index SHALL be created on the collection

#### Scenario: Index creation is idempotent across restarts

- **GIVEN** a Qdrant collection that already has a `device_id` keyword index
- **WHEN** `ensureCollection` runs again for that collection
- **THEN** the call SHALL succeed without raising an error
- **AND** the existing index SHALL remain intact (no duplicate-index failure)

#### Scenario: Index is created on a brand-new collection

- **GIVEN** a Qdrant collection that does not yet exist
- **WHEN** `ensureCollection` creates the collection
- **THEN** a `device_id` keyword payload index SHALL be created alongside the other
  payload indexes
