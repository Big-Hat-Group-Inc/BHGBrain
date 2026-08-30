## ADDED Requirements

### Requirement: Collection and category identifiers use a slug-like charset
`collection` and `category.name` input values SHALL be restricted to a charset that cannot collide once embedded in a Qdrant collection name — alphanumeric characters and hyphens only, 1-100 characters.

#### Scenario: A collection name containing a literal dot is rejected
- **WHEN** a client calls `remember` (or `recall`/`search`/`collections`/`consolidate`) with `collection: "a.b"`
- **THEN** the call is rejected with `INVALID_INPUT`

#### Scenario: A collection name containing a slash is rejected
- **WHEN** a client calls any tool accepting `collection` with a value containing `/`
- **THEN** the call is rejected with `INVALID_INPUT`

#### Scenario: A category name with the same disallowed characters is rejected
- **WHEN** a client calls `category` with `action: "set"` and a `name` containing `.` or `/`
- **THEN** the call is rejected with `INVALID_INPUT`

### Requirement: The Qdrant collection-name encoder is injective independent of schema
The function that encodes `namespace`/`collection` values into a Qdrant collection name SHALL be injective for any input, not only for input the current schema happens to allow.

#### Scenario: A literal marker character in collection does not collide with an encoded slash
- **WHEN** one memory is stored with `collection` value `X` containing a literal occurrence of the encoder's substitution marker character
- **AND** another memory is stored with a different `collection` value `Y` that encodes to the same marker character in that position
- **THEN** `X` and `Y` resolve to distinct Qdrant collection names

#### Scenario: Existing namespace-slash safety is preserved
- **WHEN** a namespace containing `/` is used exactly as covered by `fix-namespace-slash-collection-naming`'s existing tests
- **THEN** those tests continue to pass unchanged
