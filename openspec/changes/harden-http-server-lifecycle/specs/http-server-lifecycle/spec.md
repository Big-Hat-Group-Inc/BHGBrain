## ADDED Requirements

### Requirement: Shutdown SHALL persist all buffered SQLite state on both transports
On SIGTERM or SIGINT — and, for the stdio transport, on transport close — the
server SHALL cancel the deferred-flush timer, flush any dirty SQLite state to
disk, stop lifecycle timers, and drain live connections before exiting.

#### Scenario: SIGTERM with a pending deferred flush
- **WHEN** access-tracking writes have marked SQLite dirty and the 5 s deferred
  flush timer has not yet fired
- **AND** the process receives SIGTERM
- **THEN** the dirty database image SHALL be flushed to disk before the process
  exits
- **AND** the process SHALL exit with code 0

#### Scenario: Stdio client closes the pipe
- **WHEN** the server runs on the stdio transport and the client closes stdin
- **THEN** the same flush-and-stop teardown SHALL run before the process exits

#### Scenario: Repeated signals
- **WHEN** a second SIGTERM or SIGINT arrives while shutdown is in progress
- **THEN** the teardown SHALL NOT run twice

### Requirement: Shutdown SHALL complete within a bounded deadline
A hung drain SHALL NOT prevent termination or persistence: shutdown SHALL be
bounded by a hard deadline that still flushes SQLite synchronously.

#### Scenario: Drain exceeds the deadline
- **WHEN** shutdown starts and in-flight connections do not drain within 10
  seconds
- **THEN** the server SHALL log a shutdown-timeout event, synchronously flush
  any dirty SQLite state, and exit with a non-zero code

### Requirement: Every HTTP error response SHALL be a structured JSON envelope
All HTTP failure paths SHALL return the `{error: {code, message, retryable}}`
envelope; no response SHALL contain a stack trace or an HTML error page,
regardless of `NODE_ENV`.

#### Scenario: Malformed resource URI
- **WHEN** a client requests `GET /resource?uri=not-a-url`
- **THEN** the response SHALL be a 400 JSON envelope with code `INVALID_INPUT`
- **AND** the body SHALL contain no stack trace

#### Scenario: Malformed JSON request body
- **WHEN** a client POSTs a syntactically invalid JSON body to a tool endpoint
- **THEN** the response SHALL be a 400 JSON envelope with code `INVALID_INPUT`

#### Scenario: Unexpected handler failure
- **WHEN** a route handler throws or rejects with an unanticipated error
- **THEN** the response SHALL be a 500 JSON envelope with code `INTERNAL` and a
  generic message
- **AND** the underlying error SHALL be logged server-side

### Requirement: HTTP socket timeouts SHALL be proxy-safe and configurable
The server SHALL apply keep-alive, headers, and request timeouts from validated
configuration, with defaults that exceed common reverse-proxy idle timeouts.

#### Scenario: Defaults protect proxied deployments
- **WHEN** no timeout configuration is supplied
- **THEN** the keep-alive timeout SHALL be 65 s, the headers timeout 66 s, and
  the request timeout 300 s

#### Scenario: Invalid timeout relation is rejected
- **WHEN** configuration sets `headers_timeout_ms` less than or equal to
  `keep_alive_timeout_ms`
- **THEN** config validation SHALL fail with an actionable message

### Requirement: Responses SHALL carry hardened headers and support compression
The server SHALL NOT advertise its framework, SHALL send
`X-Content-Type-Options: nosniff`, and SHALL compress compressible responses
without breaking SSE streams.

#### Scenario: Header hygiene
- **WHEN** any HTTP response is sent
- **THEN** it SHALL NOT include `X-Powered-By`
- **AND** it SHALL include `X-Content-Type-Options: nosniff`

#### Scenario: Compression respects SSE
- **WHEN** a client sends `Accept-Encoding: gzip` for a large JSON response
- **THEN** the response SHALL be compressed
- **AND WHEN** the response is `text/event-stream`
- **THEN** it SHALL NOT be compressed
