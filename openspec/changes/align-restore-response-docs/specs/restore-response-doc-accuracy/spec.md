# Spec: restore-response-doc-accuracy

## ADDED Requirements

### Requirement: Restore response documentation reflects emitted fields

User-facing documentation of the `backup.restore` response SHALL accurately reflect the
fields the code actually emits. The documented response schema SHALL name the activation
indicator field as `metadata_activated` (matching `RestoreResult` in
`src/domain/types.ts` and the object returned by `BackupService.restore`), SHALL document
the `vector_reconciliation` field, and SHALL NOT reference any restore response field
that the code does not emit (in particular the field `activated`).

#### Scenario: README documents the activation indicator with its real field name

- **WHEN** a reader consults the README for the `backup.restore` response shape
- **THEN** the documented activation indicator field is named `metadata_activated`
- **AND** no occurrence of a restore response field named `activated` remains in the README
- **AND** the documented field name matches the key emitted by the code (`metadata_activated`)

#### Scenario: README documents the vector reconciliation field

- **WHEN** a reader consults the documented `backup.restore` response schema
- **THEN** the `vector_reconciliation` field is documented as part of the response
- **AND** the documented response schema matches the full `RestoreResult` shape (`memory_count`, `metadata_activated`, `vector_reconciliation`)

#### Scenario: Integrator codes against the documented field and reads the live value

- **WHEN** an integrator reads the restore response field named in the documentation
- **AND** the server returns a successful restore
- **THEN** the documented field name resolves to the emitted boolean value (not `undefined`)
- **AND** the integrator can correctly determine that restored data is immediately active
