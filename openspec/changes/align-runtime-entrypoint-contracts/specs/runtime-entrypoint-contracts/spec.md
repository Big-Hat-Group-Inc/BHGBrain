## Purpose

Defines consistent capabilities, configuration, errors, lifecycle handling, and secure defaults across HTTP, MCP, CLI, bootstrap, and container entrypoints.

## ADDED Requirements

### Requirement: Entrypoints SHALL construct equivalent tool capabilities
Server and CLI entrypoints SHALL use one context construction contract or explicitly report unavailable optional capabilities before dispatch.

#### Scenario: Same tool is invoked over CLI and MCP
- **WHEN** a tool is supported by both entrypoints with the same configuration
- **THEN** it receives equivalent storage, provider, lifecycle, and observability dependencies

### Requirement: Startup hydration SHALL be resumable
A partial vector-to-SQLite bootstrap SHALL persist incomplete state, continue other collections, degrade health, and retry on later startup or repair until all collections converge.

#### Scenario: One collection fails during first-device hydration
- **WHEN** earlier collections have already committed and a later collection fails
- **THEN** the failed and remaining collections are recorded for retry
- **AND** a non-zero local row count does not suppress future hydration

### Requirement: Errors SHALL have one cross-transport meaning
The same classified error SHALL map to a non-success HTTP status, MCP error signal, structured envelope where required, and non-zero CLI exit code.

#### Scenario: Tool validation fails
- **WHEN** invalid input is sent through REST, MCP, or CLI
- **THEN** every entrypoint signals failure through its native status channel and preserves the same error code

### Requirement: Destructive bootstrap actions SHALL require explicit intent
Bootstrap reset SHALL be advertised as destructive and SHALL require an explicit confirmation field before deleting stored state.

#### Scenario: Reset is requested without confirmation
- **WHEN** a caller invokes bootstrap reset without the confirmation value
- **THEN** no data is deleted and the tool returns invalid input

### Requirement: Configuration SHALL be strict, validated, and source-aware
Unknown keys and invalid URLs, ports, booleans, or schedules SHALL fail with their file path and field path. Environment overrides SHALL be revalidated and SHALL NOT be persisted as user configuration or leak credentials.

#### Scenario: Runtime security override is temporary
- **WHEN** an operator starts once with an environment override
- **THEN** later starts without it return to the file or default value
- **AND** credential-bearing runtime values were never written to `config.json`

### Requirement: Startup and shutdown failures SHALL be structured and bounded
Listener errors and fatal process events SHALL be logged through the service logger, trigger non-zero shutdown, and cancel tracked background retry and session timers within the drain deadline.

#### Scenario: HTTP port is already in use
- **WHEN** the server cannot bind its configured address
- **THEN** startup reports a structured listener failure and closes opened resources

### Requirement: CLI filesystem entrypoints SHALL be URL-safe
CLI server launching SHALL convert module URLs using platform-correct filesystem semantics.

#### Scenario: Entry path contains escaped or platform-specific characters
- **WHEN** the installed module path is represented as a file URL
- **THEN** the spawned process receives the correct native filesystem path

### Requirement: Container defaults SHALL protect credentials and vector data
Generated bearer credentials SHALL be written to a protected file without printing their value, and bundled vector ports SHALL bind only to loopback unless an authenticated external exposure is explicitly configured.

#### Scenario: Default self-hosted compose stack starts
- **WHEN** no external vector exposure is configured
- **THEN** the vector service is unreachable from non-loopback host interfaces
- **AND** container logs reveal only how to locate the token file, not the token
