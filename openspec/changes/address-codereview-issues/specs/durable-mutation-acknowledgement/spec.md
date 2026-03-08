## ADDED Requirements

### Requirement: Mutating tool success implies durable persistence
Mutating tool handlers SHALL durably persist their changes before returning success.

#### Scenario: Category set mutation
- **WHEN** `category.set` returns success
- **THEN** the category change is durably persisted and survives immediate process restart

#### Scenario: Category delete mutation
- **WHEN** `category.delete` returns success
- **THEN** the deletion is durably persisted and survives immediate process restart
