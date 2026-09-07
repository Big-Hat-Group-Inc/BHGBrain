## 1. Configuration and Secure Defaults

- [x] 1.1 Make root and nested configuration schemas strict and add URL, port, boolean, and cron validation; verify unknown/invalid values report file and field paths.
- [x] 1.2 Separate raw file configuration from runtime environment overlays and revalidate the final object; verify temporary security overrides and credential-bearing URLs are never persisted.
- [x] 1.3 Persist config/device changes atomically with restrictive modes and verify interrupted writes preserve the previous readable file.
- [ ] 1.4 Bind the bundled vector service to loopback, stop printing generated bearer tokens, and align README commands; verify the default compose configuration exposes neither vector data nor token values externally.

## 2. Unified Context and Error Contracts

- [ ] 2.1 Extract one tool-context factory used by server and CLI with explicit optional capability checks and verify equivalent tools receive equivalent provider, breaker, logger, and lifecycle dependencies.
- [ ] 2.2 Export one strict error-envelope predicate and native REST/MCP/CLI adapters and verify identical classified failures map to HTTP status, MCP error state, and non-zero CLI exit.
- [ ] 2.3 Convert resource errors into MCP errors and validate REST tool names before dispatch; verify unknown tools/resources never appear as successful content.
- [ ] 2.4 Mark bootstrap as destructive and require an exact reset confirmation value; verify omitted or wrong confirmation leaves storage unchanged.

## 3. Startup, Hydration, and Shutdown

- [ ] 3.1 Add durable per-collection bootstrap progress and per-collection error isolation and verify a partial first startup retries failed collections despite non-zero local rows.
- [ ] 3.2 Await HTTP listener readiness before starting schedulers and verify EADDRINUSE produces a structured fatal event followed by resource cleanup.
- [ ] 3.3 Add tracked lifecycle for background reconciliation timers plus structured unhandled-rejection and uncaught-exception shutdown handling; verify timers cannot fire against a closed store.
- [ ] 3.4 Replace URL pathname entrypoint construction with platform-correct file URL conversion and verify escaped-space and platform path fixtures.
- [ ] 3.5 Run CLI, HTTP, MCP, bootstrap, configuration, startup/shutdown, and container checks plus `npm run lint`, `npm test`, and `npm run build`.
