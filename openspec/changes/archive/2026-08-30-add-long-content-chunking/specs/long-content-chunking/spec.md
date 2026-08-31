## ADDED Requirements

### Requirement: `remember` SHALL reject content beyond a configurable length threshold
`remember` SHALL compare submitted content length against
`pipeline.long_content_threshold_chars` before invoking the write pipeline. Content
strictly longer than the threshold SHALL be rejected with an `INVALID_INPUT` error and
SHALL NOT be embedded, deduplicated, or stored.

#### Scenario: Content over the threshold is rejected
- **WHEN** `remember` is called with content longer than
  `pipeline.long_content_threshold_chars`
- **THEN** the call SHALL fail with an `INVALID_INPUT` error
- **AND** no embedding SHALL be generated
- **AND** no memory SHALL be written

#### Scenario: Content at or under the threshold is unaffected
- **WHEN** `remember` is called with content less than or equal to
  `pipeline.long_content_threshold_chars`
- **THEN** the call SHALL proceed through the existing write pipeline unchanged

### Requirement: The rejection message SHALL point the caller at `import`
The `INVALID_INPUT` error raised for over-threshold content SHALL name the actual
content length, the configured threshold, and the `import` tool with
`format: "freeform"` as the recommended alternative.

#### Scenario: Error message names the fix
- **WHEN** `remember` rejects content for exceeding the threshold
- **THEN** the error message SHALL include the submitted content's character count
- **AND** the error message SHALL include the configured threshold value
- **AND** the error message SHALL direct the caller to the `import` tool with
  `format: "freeform"`

### Requirement: The threshold SHALL be configurable and validated
`pipeline.long_content_threshold_chars` SHALL be a positive integer, no greater than
the `remember` content schema's own maximum length, with a default of 8,000.

#### Scenario: Default threshold applies when unconfigured
- **WHEN** `config.json` does not specify `pipeline.long_content_threshold_chars`
- **THEN** the effective threshold SHALL be 8,000 characters

#### Scenario: Invalid threshold values are rejected at config load
- **WHEN** `pipeline.long_content_threshold_chars` is set to zero, a negative number,
  a non-integer, or a value greater than the `remember` content schema's maximum
  length
- **THEN** config loading SHALL fail validation

### Requirement: The guard SHALL NOT apply to `import` or `bootstrap` writes
The content-length guard SHALL be scoped to the `remember` tool's entry point only.
Calls into the shared write pipeline from `import` or `bootstrap` SHALL NOT be subject
to the threshold, since those callers already submit pre-chunked candidates.

#### Scenario: `import` writes are unaffected by the threshold
- **WHEN** `import` processes a parsed chunk longer than
  `pipeline.long_content_threshold_chars`
- **THEN** the write SHALL proceed through the write pipeline exactly as before this
  change

#### Scenario: `bootstrap` writes are unaffected by the threshold
- **WHEN** `bootstrap` writes a candidate longer than
  `pipeline.long_content_threshold_chars`
- **THEN** the write SHALL proceed through the write pipeline exactly as before this
  change
