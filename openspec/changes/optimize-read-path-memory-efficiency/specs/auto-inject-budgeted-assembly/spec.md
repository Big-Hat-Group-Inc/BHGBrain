## ADDED Requirements

### Requirement: Auto-inject assembly must respect the character budget while building content
The system SHALL avoid assembling oversized intermediate payloads when generating auto-inject context.

#### Scenario: Large category bodies exceed payload budget
- **WHEN** category content alone can exceed the configured auto-inject character budget
- **THEN** the builder stops or truncates incrementally while assembling the payload
- **THEN** it does not require full concatenation of all category content before truncation

### Requirement: Auto-inject must preserve truncation semantics
The system SHALL continue to report whether the payload was truncated.

#### Scenario: Content exceeds budget
- **WHEN** the available memory and category content exceed the configured budget
- **THEN** the returned payload is marked truncated
- **THEN** the payload content fits within the configured maximum size
