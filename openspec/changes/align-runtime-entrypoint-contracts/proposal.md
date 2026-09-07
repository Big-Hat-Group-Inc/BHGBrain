## Why

The server, CLI, REST facade, MCP handlers, bootstrap tools, and configuration loader expose different capabilities and error semantics. Startup and shutdown gaps can also turn ordinary bind or background failures into unstructured process exits, while unsafe defaults and persisted environment overrides weaken deployment security.

## What Changes

- Build server and CLI tool contexts through one factory and make startup hydration resumable until every collection is reconciled.
- Use one strict error-envelope predicate and map failures consistently to REST status, MCP errors, and non-zero CLI exits.
- Mark bootstrap reset as destructive and require explicit confirmation before hard deletion.
- Parse, validate, and atomically persist strict configuration without writing runtime overrides or credential-bearing URLs; use restrictive filesystem modes.
- Fail startup cleanly on listener errors, track/cancel reconciliation timers during shutdown, and add structured fatal process handling.
- Resolve CLI entrypoints with URL-safe filesystem conversion and secure container defaults without logging bearer credentials or exposing Qdrant publicly.

## Capabilities

### New Capabilities
- `runtime-entrypoint-contracts`: Defines consistent context construction, errors, configuration, bootstrap safety, startup/shutdown behavior, and deployment defaults across entrypoints.

### Modified Capabilities

## Impact

- Affected code: `src/index.ts`, `src/cli/index.ts`, `src/transport/http.ts`, `src/transport/mcp-server.ts`, `src/resources/index.ts`, `src/tools/bootstrap.ts`, `src/tools/schemas.ts`, `src/config/index.ts`, `src/backup/index.ts`, Docker files, README, and contract tests.
- Audit coverage: F11, F19, F20, F45-F47, F49-F51, F66, F67, F88, and F94.
- Compatibility: scripts will receive non-zero exit codes and HTTP error statuses where failures previously appeared successful.
