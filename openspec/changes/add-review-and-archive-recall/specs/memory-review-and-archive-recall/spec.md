## ADDED Requirements

### Requirement: The review queue SHALL be listable and actionable
Memories whose review date is due SHALL be listable (namespace-scoped, oldest due
first, paginated), and each SHALL be dispositionable as kept or archived.

#### Scenario: Listing due memories
- **WHEN** a client lists the review queue
- **THEN** non-archived memories with a due (or within the requested look-ahead)
  review date SHALL be returned oldest-due first with pagination

#### Scenario: Keeping a memory
- **WHEN** a client confirms a memory via keep
- **THEN** its review date and expiry SHALL be re-extended per its tier's lifecycle
  policy
- **AND** a lifecycle audit event SHALL record the confirmation

#### Scenario: Archiving from review
- **WHEN** a client archives a memory via review
- **THEN** the existing archive transition SHALL apply (vector removed, row archived,
  ARCHIVE audit event)
- **AND** archiving an already-archived memory SHALL fail with CONFLICT

### Requirement: Archived memories SHALL be searchable on retained metadata
Search SHALL optionally include archived memories, matched on their retained summary
and tags, clearly marked and without access recording.

#### Scenario: Opting into archived results
- **WHEN** a search sets include_archived
- **AND** an archived memory's summary or tags match the query
- **THEN** it SHALL be returned marked as archived
- **AND** no access SHALL be recorded for it

#### Scenario: Default exclusion
- **WHEN** a search does not set include_archived
- **THEN** archived memories SHALL NOT appear in results

### Requirement: An archived memory SHALL be restorable as a provenance-carrying stub
Restore SHALL create an active memory from the archive record's retained metadata,
embedded normally, linked to its archive origin, without deleting the archive row.

#### Scenario: Restoring an archived memory
- **WHEN** a client restores an archived entry
- **THEN** an active memory SHALL be created from the retained summary and tags at
  the original tier, with an identifying marker tag
- **AND** a RESTORE audit event SHALL link the archive origin
- **AND** the archive row SHALL be retained
