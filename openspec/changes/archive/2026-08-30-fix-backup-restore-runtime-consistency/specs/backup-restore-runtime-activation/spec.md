## ADDED Requirements

### Requirement: Restore success activates restored state
A successful backup restore SHALL activate restored database state for the running process before returning success.

#### Scenario: Restore succeeds and runtime state is refreshed
- **WHEN** a valid backup file passes integrity checks
- **THEN** the restored database bytes are loaded into active runtime storage
- **THEN** subsequent reads return restored data without requiring process restart

### Requirement: Restore failure must not report false success
The system MUST NOT return success when restore bytes are written but runtime activation fails.

#### Scenario: Activation step fails after file write
- **WHEN** runtime storage reload fails after validated restore write
- **THEN** the restore operation returns an error outcome
- **THEN** the response includes actionable operator guidance

### Requirement: Restore response communicates activation outcome
Backup restore responses SHALL include activation status metadata.

#### Scenario: Successful restore response
- **WHEN** restore completes and runtime state is active
- **THEN** response includes restored memory count and an explicit activation indicator
