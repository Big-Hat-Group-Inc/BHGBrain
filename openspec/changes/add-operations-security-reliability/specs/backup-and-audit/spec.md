## ADDED Requirements

### Requirement: Backup operations SHALL support create list and restore actions
The backup tool SHALL support backup creation, listing, and restore using a durable archive format containing metadata and vector state snapshots.

#### Scenario: Backup create returns archive metadata
- **WHEN** a backup is created
- **THEN** response includes path, size, memory count, and created timestamp

#### Scenario: Backup list returns known backup entries
- **WHEN** backup list is requested
- **THEN** response includes available backup archives with metadata

### Requirement: Restore SHALL verify integrity before completion
Restore operations SHALL verify backup integrity using memory count and checksum validation before declaring success.

#### Scenario: Valid backup restores successfully
- **WHEN** restore is requested with an intact backup archive
- **THEN** restore completes and integrity validation passes

#### Scenario: Corrupt backup is rejected
- **WHEN** restore is requested with a corrupted or mismatched archive
- **THEN** restore fails and no successful completion response is returned

### Requirement: Audit logging SHALL capture all write and delete operations
The system SHALL record audit events for memory writes and deletes including timestamp, namespace, operation type, and client id.

#### Scenario: Write operation emits audit event
- **WHEN** a memory write operation succeeds
- **THEN** an audit entry is recorded with required metadata

#### Scenario: Delete operation emits audit event
- **WHEN** a memory delete operation succeeds
- **THEN** an audit entry is recorded with required metadata
