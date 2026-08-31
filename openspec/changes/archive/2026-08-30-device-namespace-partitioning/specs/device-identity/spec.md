## MODIFIED Requirements

### Requirement: Device identity resolution honors environment precedence

The system SHALL resolve a stable `device_id` for each BHGBrain instance, and the
`BHGBRAIN_DEVICE_ID` environment variable SHALL take precedence over a persisted
`device.id` in `config.json`, consistent with the project-wide contract that
`BHGBRAIN_*` environment overrides win over file-based config. The resolution order
SHALL be: `BHGBRAIN_DEVICE_ID` environment variable → persisted `config.device.id` →
`os.hostname()` (lowercased and sanitized to `[a-zA-Z0-9._-]`, length 1–64). When the
environment variable supplies the value, the resolved id SHALL be re-persisted to
`config.json`. The system SHALL write `config.json` only when the device id was newly
synthesized (or the config file is absent), not unconditionally on every startup.

#### Scenario: Environment variable overrides a previously persisted device id

- **GIVEN** `config.json` already contains `device.id` of `"workstation"`
- **AND** `BHGBRAIN_DEVICE_ID` is set to `"cloudpc"`
- **WHEN** the server resolves the device identity on startup
- **THEN** the resolved `device_id` SHALL be `"cloudpc"`
- **AND** the value `"cloudpc"` SHALL be re-persisted to `config.json`

#### Scenario: Persisted id is used when no environment override is present

- **GIVEN** `config.json` contains `device.id` of `"workstation"`
- **AND** `BHGBRAIN_DEVICE_ID` is not set
- **WHEN** the server resolves the device identity on startup
- **THEN** the resolved `device_id` SHALL be `"workstation"`
- **AND** `config.json` SHALL NOT be rewritten (no newly synthesized id)

#### Scenario: Hostname fallback is synthesized and persisted once

- **GIVEN** `config.json` has no `device.id`
- **AND** `BHGBRAIN_DEVICE_ID` is not set
- **AND** the hostname sanitizes to `"my-box"`
- **WHEN** the server resolves the device identity on startup
- **THEN** the resolved `device_id` SHALL be `"my-box"`
- **AND** `"my-box"` SHALL be persisted to `config.json`
- **AND** a subsequent startup with the same inputs SHALL NOT rewrite `config.json`

#### Scenario: Sanitized hostname truncation does not leave a trailing hyphen

- **GIVEN** a hostname that sanitizes to more than 64 characters
- **WHEN** the device id is synthesized from the hostname
- **THEN** the result SHALL be sliced to at most 64 characters and SHALL NOT end in `-`
- **AND** the result SHALL match `^[a-zA-Z0-9._-]{1,64}$`
