## ADDED Requirements

### Requirement: Resource list limit is validated and bounded
Resource list endpoints SHALL validate `limit` as an integer within configured bounds.

#### Scenario: Limit is non-numeric
- **WHEN** a list request provides `limit=abc`
- **THEN** the system returns `INVALID_INPUT`

#### Scenario: Limit is out of bounds
- **WHEN** a list request provides `limit` below minimum or above maximum
- **THEN** the system returns `INVALID_INPUT`

#### Scenario: Limit within bounds
- **WHEN** a list request provides valid `limit` inside allowed range
- **THEN** the system returns a paginated result constrained to that limit
