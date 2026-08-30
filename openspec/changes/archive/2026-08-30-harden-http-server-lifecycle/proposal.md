## Why

The HTTP transport is production-shaped in its security posture (bearer auth,
rate limiting, loopback default) but not in its runtime behavior. Four gaps,
all verified against the current tree:

- **Shutdown loses buffered SQLite writes.** The HTTP branch now has SIGINT/
  SIGTERM handlers (`src/index.ts:138-153`, landed with
  `adopt-streamable-http-mcp-transport`): they close live MCP sessions, stop the
  cleanup scheduler, close the listener, and `process.exit(0)` — but never touch
  storage. Access-tracking writes are coalesced behind a 5 s deferred-flush timer
  (`SqliteStore.scheduleDeferredFlush`, `src/storage/sqlite.ts:437-444`,
  scheduled from `src/search/index.ts:388` and `src/resources/index.ts:89`);
  exiting while that timer is pending silently drops the dirty database image.
  `SqliteStore.close()` (`src/storage/sqlite.ts:1560-1564`) already does exactly
  the right cancel-timer → flush-if-dirty → close sequence, and nothing calls it
  at process shutdown. The stdio branch registers no shutdown handling at all.
  There is also no hard deadline: `httpServer.close()` waits for in-flight
  requests indefinitely, so one hung request converts `docker stop` into a
  SIGKILL at the container grace period — the exact data-losing kill the handler
  exists to prevent.
- **Express's development error page leaks internals.** `createHttpServer`
  (`src/transport/http.ts`) registers no trailing 4-arg error middleware, and
  the Dockerfile never sets `NODE_ENV` (its ENV block, `Dockerfile:27-29`, sets
  only `BHGBRAIN_*` vars). `GET /resource?uri=not-a-url` reaches
  `new URL(uri)` (`src/resources/index.ts:38`); the `TypeError` rejects the
  async handler and Express 5 renders its default HTML error page with a full
  stack trace — on a server the container image binds to `0.0.0.0`. Malformed
  JSON bodies (`express.json` at `src/transport/http.ts:74`) take the same HTML
  path. Both break the structured `{error:{code,message,retryable}}` envelope
  (`BrainError.toEnvelope`, `src/errors/index.ts:13-21`) precisely where clients
  are least prepared for it.
- **Node-default server timeouts are wrong for this deployment shape.**
  `keepAliveTimeout` defaults to 5 s — below every common reverse-proxy idle
  timeout, producing intermittent 502s in the explicitly supported
  `security.trust_proxy` mode; `requestTimeout` (300 s) and `headersTimeout`
  (60 s) permit long slow-loris holds. None are configurable: `transport.http`
  in the Zod schema carries only `enabled`/`host`/`port`/`bearer_token_env`
  (`src/config/index.ts:102-108`).
- **Response hygiene.** `X-Powered-By: Express` is advertised, no
  `X-Content-Type-Options: nosniff` is sent, and 30 KB+ JSON payloads (inject,
  large recalls) go uncompressed. Neither `compression` nor `helmet` is a
  dependency today.

## What Changes

- **Graceful shutdown that persists state.** Extend the existing HTTP shutdown
  handler: after draining sessions and the listener, call `SqliteStore.close()`
  (cancel deferred flush, flush if dirty, close); add a 10 s unref'd
  hard-deadline timer that performs a last synchronous `flushIfDirty()` and
  exits non-zero if the drain hangs. Mirror the same flush-and-stop handling on
  the stdio branch (signal handlers plus transport close).
- **Terminal JSON error middleware.** A final 4-arg Express error handler that
  maps `BrainError` to its envelope and status, body-parser errors to
  400/413 envelopes, and everything else to a generic 500
  `{error:{code:'INTERNAL',...}}` with no stack in the body; wrap the resource
  URI parse so a malformed `uri` yields an `INVALID_INPUT` envelope; set
  `NODE_ENV=production` in the Dockerfile as defense in depth.
- **Configurable server timeouts.** New `transport.http` config keys
  (`keep_alive_timeout_ms`, `headers_timeout_ms`, `request_timeout_ms`) applied
  to the captured `http.Server`, with proxy-safe defaults (65 s keep-alive,
  66 s headers, 300 s request).
- **Headers and compression.** Disable `x-powered-by`, send
  `X-Content-Type-Options: nosniff`, and add `compression` middleware with a
  filter that skips SSE (`text/event-stream` on `GET /mcp`).

Explicitly **distinct from** `harden-http-auth-and-proxy-trust` (authentication
and proxy trust derivation) and `harden-http-health-rate-limit-and-resource-bounds`
(health-endpoint auth policy and rate limiting) — this change does not touch
auth, rate limiting, or `/health` policy. It **builds on** the teardown
introduced by `adopt-streamable-http-mcp-transport` (MCP session close) and
**complements** `coalesce-and-fsync-sqlite-flushes` (flush durability/policy):
this change only guarantees the pending deferred flush is executed at shutdown,
whatever the flush implementation is.

## Capabilities

### New Capabilities

- `http-server-lifecycle`: The server shuts down gracefully with all buffered
  SQLite state persisted and a bounded drain deadline, returns structured JSON
  error envelopes for every HTTP failure path, applies configurable
  proxy-compatible socket timeouts, and serves responses with hardened headers
  and compression.

### Modified Capabilities

## Impact

- Affected code: `src/index.ts` (shutdown handlers, both transport branches,
  timeout application), `src/transport/http.ts` (error middleware, headers,
  compression), `src/resources/index.ts` (URI parse guard),
  `src/config/index.ts` (new `transport.http` keys), `Dockerfile`
  (`NODE_ENV=production`), co-located tests.
- New runtime dependency: `compression` (helmet intentionally not added — see
  design).
- Behavior: error responses that previously rendered HTML become JSON
  envelopes; shutdown persists data and always terminates within the deadline;
  socket timeout defaults change from Node's to proxy-safe values.
- Docs: new config keys + shutdown semantics are user-facing → `README.md` and
  the four translations, `package.json` version bump. `.env.example` unchanged
  (no new env vars).
