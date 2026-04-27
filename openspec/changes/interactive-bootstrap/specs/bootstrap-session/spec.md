## ADDED Requirements

### Requirement: Bootstrap tool start action
The system SHALL expose a `bhgbrain.bootstrap` MCP tool with an `action: "start"` parameter that initiates or resumes a bootstrap session for a given namespace.

#### Scenario: First-time start
- **WHEN** `bootstrap` is called with `action: "start"` and no session exists for the namespace
- **THEN** the system SHALL create a new session with all 12 sections marked as pending and return the first section's title, questions, and instructions

#### Scenario: Resume existing session
- **WHEN** `bootstrap` is called with `action: "start"` and a session already exists with some sections complete
- **THEN** the system SHALL return the first incomplete section's title, questions, and instructions

#### Scenario: All sections complete
- **WHEN** `bootstrap` is called with `action: "start"` and all 12 sections are complete
- **THEN** the system SHALL return a completion message with a summary of all stored memories

### Requirement: Bootstrap tool submit action
The system SHALL accept `action: "submit"` with a `section` number and `answers` object, store the answers as discrete memories via the write pipeline, and advance the session.

#### Scenario: Successful section submission
- **WHEN** `submit` is called with a valid section number and answers
- **THEN** the system SHALL parse the answers into discrete memories with the section's designated collection, tier, type, importance, and tags, store them via the write pipeline, mark the section as complete, record the created memory IDs, and return the next incomplete section

#### Scenario: Submit for already-complete section
- **WHEN** `submit` is called for a section that is already marked complete
- **THEN** the system SHALL return an error indicating the section is already complete and suggest using `reset` first

#### Scenario: Submit with invalid section number
- **WHEN** `submit` is called with a section number outside 1–12
- **THEN** the system SHALL return an error with code `INVALID_INPUT`

### Requirement: Bootstrap tool status action
The system SHALL accept `action: "status"` and return the current session progress.

#### Scenario: Status with active session
- **WHEN** `status` is called and a session exists
- **THEN** the system SHALL return a list of all 12 sections with their status (pending/complete), memory count per section, total memories stored, and last updated timestamp

#### Scenario: Status with no session
- **WHEN** `status` is called and no session exists for the namespace
- **THEN** the system SHALL return a message indicating no session exists and suggest calling `start`

### Requirement: Bootstrap tool reset action
The system SHALL accept `action: "reset"` with a `section` number, delete all memories created for that section, and mark it as pending.

#### Scenario: Reset a complete section
- **WHEN** `reset` is called with a valid section number that is marked complete
- **THEN** the system SHALL delete all memories whose IDs are tracked for that section, mark the section as pending, and return confirmation with the number of memories removed

#### Scenario: Reset a pending section
- **WHEN** `reset` is called for a section that is already pending
- **THEN** the system SHALL return a message indicating the section is already pending (no-op)

### Requirement: Session persistence across conversations
The system SHALL persist bootstrap session state in SQLite so that sessions survive across MCP client restarts and conversation boundaries.

#### Scenario: Resume after client restart
- **WHEN** a user starts a new MCP conversation and calls `bootstrap` with `action: "start"`
- **THEN** the system SHALL load the existing session from SQLite and resume from the first incomplete section
