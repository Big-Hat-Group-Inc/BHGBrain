## Context

The HTTP branch of `main()` captures the listener
(`const httpServer = app.listen(...)`, `src/index.ts:129`) and registers a
`shutdown(signal)` closure (`src/index.ts:138-153`) that closes MCP sessions
(`McpSessionManager.closeAll()`, `src/transport/mcp-http.ts:144-146`), stops the
`CleanupScheduler`, and closes the listener before `process.exit(0)`. Storage is
never flushed: `SqliteStore` batches read-path writes behind a 5 s
`deferredFlushTimer` (`DEFERRED_FLUSH_MS`, `src/storage/sqlite.ts:344`;
`scheduleDeferredFlush` at `437-444`), and its `close()`
(`src/storage/sqlite.ts:1560-1564`) — which cancels the timer and runs
`flushIfDirty()` — has no caller on any shutdown path. The stdio branch
(`src/index.ts:104-122`) registers no handlers.

`createHttpServer` (`src/transport/http.ts`) ends at its route registrations;
there is no 4-arg error middleware, so any thrown/rejected handler error —
body-parser `SyntaxError`s from `express.json()` (`src/transport/http.ts:74`),
the `new URL(uri)` `TypeError` (`src/resources/index.ts:38`), unexpected
storage failures — falls through to Express's finalhandler, which in
non-production renders an HTML stack trace. Existing middleware already emits
`{error:{code,message,retryable}}` envelopes for 401/400/429/413
(`src/transport/middleware.ts:43,52,114,141,168`), so the terminal handler has
an established vocabulary to match (`ErrorCode` union,
`src/domain/types.ts:28`; `BrainError.toEnvelope`, `src/errors/index.ts:13-21`).

Note: this design was verified against a working tree where
`adopt-streamable-http-mcp-transport` is partially landed (uncommitted); line
numbers cite that state. Implementation must rebase task references if that
change moves.

## Goals / Non-Goals

Goals:
- No committed-to-SQLite data lost across `docker stop`, systemd restart, or
  Ctrl-C, on either transport.
- Shutdown always terminates within a bounded deadline, persisting state even
  when the drain hangs.
- Every HTTP error response is a structured JSON envelope; no stack traces or
  HTML leave the process regardless of `NODE_ENV`.
- Socket timeouts safe behind reverse proxies and resistant to slow-loris,
  operator-tunable via config.
- Baseline response hygiene: no server fingerprint header, nosniff, gzip for
  the JSON-heavy endpoints.

Non-Goals:
- No auth, proxy-trust, rate-limit, or `/health` policy changes
  (`harden-http-auth-and-proxy-trust` and
  `harden-http-health-rate-limit-and-resource-bounds` own those).
- No change to flush frequency, coalescing policy, or fsync durability
  (`coalesce-and-fsync-sqlite-flushes` owns that); this change only guarantees
  the *pending* flush runs before exit.
- No full helmet adoption or CSP work — this server serves JSON/SSE to
  programmatic clients, not browsers.
- No connection draining beyond what `server.close()` + MCP session close
  provide (no per-request abort signals).

## Decisions

- **Shutdown ordering**: (1) synchronous `sqlite.flushIfDirty()` immediately on
  signal — it is cheap when clean and caps the loss window before any async
  step can hang; (2) `mcpSessions.closeAll()` — ends the long-lived SSE
  responses that would otherwise hold `server.close()` open; (3)
  `cleanupScheduler.stop()`; (4) `httpServer.close()` (Node ≥ 19 also reaps
  idle keep-alive sockets); (5) in the close callback, `sqlite.close()` to
  cancel the deferred timer and flush anything written by requests that
  completed during the drain; (6) `process.exit(0)`. Flushing twice is
  deliberate: `flushIfDirty` no-ops when clean, and the early flush protects
  against a drain that never finishes.
- **Hard deadline**: a 10 s `setTimeout(...).unref()` armed at step (1); on
  expiry, log `shutdown_timeout`, run one last synchronous
  `sqlite.cancelDeferredFlush()` + `flushIfDirty()` (possible because the flush
  path is fully synchronous — `db.export()` + `atomicWriteFileSync`), and
  `process.exit(1)`. Non-zero exit distinguishes forced from clean shutdown for
  orchestrators. 10 s fits inside Docker's default stop grace period with
  margin.
- **Stdio parity**: the stdio branch registers the same SIGINT/SIGTERM handler
  (flush → scheduler stop → `sqlite.close()` → exit) and additionally hooks the
  transport's `onclose` (client dropped stdin) to the same teardown, since MCP
  clients typically end the child by closing its pipes rather than signaling.
  Reuse one `createShutdown(...)` helper across both branches.
- **Terminal error middleware**, registered last in `createHttpServer` (before
  the `return` at `src/transport/http.ts:140`): `instanceof BrainError` →
  `toEnvelope()` with a code→status map consistent with the middleware's
  existing choices; body-parser `SyntaxError` (`status === 400`,
  `type: 'entity.parse.failed'`) → 400 `INVALID_INPUT`;
  `type: 'entity.too.large'` → 413 with the same envelope shape
  `createSizeLimitMiddleware` uses (`src/transport/middleware.ts:168`);
  anything else → 500 `{error:{code:'INTERNAL', message:'An unexpected error
  occurred', retryable:true}}` (mirroring `handleTool`'s catch-all,
  `src/tools/index.ts:98`) with the real error logged via pino, never
  serialized into the body. Headers-already-sent delegates to `next(err)` per
  the Express contract (matters for interrupted SSE).
- **Resource URI guard**: wrap `new URL(uri)` in `ResourceHandler.handle` and
  return an `INVALID_INPUT` envelope object on parse failure — matching the
  handler's existing convention of *returning* `NOT_FOUND` envelopes for
  unknown schemes rather than throwing. The error middleware still backstops
  it, but resources are also reached via stdio and `/mcp`, where Express
  middleware does not exist.
- **`NODE_ENV=production` in the Dockerfile** ENV block: defense in depth (also
  drops Express dev-mode overhead), not the primary fix — the terminal
  middleware is what guarantees JSON envelopes in every environment, including
  bare `npm start`.
- **Timeout config keys** under `transport.http` (`src/config/index.ts:102-108`):
  `keep_alive_timeout_ms` (default 65 000 — above the common 60 s proxy idle
  timeout so the proxy, not the app, closes idle sockets),
  `headers_timeout_ms` (default 66 000; a Zod `superRefine` enforces
  `> keep_alive_timeout_ms`, Node's own documented requirement),
  `request_timeout_ms` (default 300 000, Node's default, now tunable). Applied
  as plain property assignments on the captured `httpServer`. `requestTimeout`
  bounds *receiving the request*, so long-lived SSE responses on `GET /mcp` are
  unaffected. Config-only keys — no new env vars, consistent with the fixed
  `applyEnvOverrides` set.
- **Headers without helmet**: `app.disable('x-powered-by')` plus a one-line
  middleware setting `X-Content-Type-Options: nosniff`. Helmet's remaining
  value is browser-oriented (CSP, COEP, HSTS) and irrelevant to an API/SSE
  server; a dependency is not worth two header lines.
- **Compression with an SSE filter**: add the `compression` package (plus
  `@types/compression`), `app.use`d before the routes, with a `filter` that
  declines `text/event-stream` responses — compression buffers SSE frames and
  would stall `/mcp` streams. `/metrics` text and JSON bodies compress
  normally when the client sends `Accept-Encoding`.

## Risks / Trade-offs

- **Concurrent-change churn**: `src/index.ts` and `src/transport/http.ts` are
  actively edited by `adopt-streamable-http-mcp-transport`; cited line numbers
  will drift. Mitigation: tasks reference function/handler names alongside
  lines, and this change must be built after that one settles.
- **Double-flush cost**: the early flush serializes the whole DB image (sql.js
  has no incremental write). Acceptable: it happens once, at shutdown;
  `coalesce-and-fsync-sqlite-flushes` addresses flush cost generally.
- **Behavioral change for error consumers**: clients that (mis)relied on HTML
  error bodies or Node-default timeouts see different behavior. Envelopes match
  the documented error contract, and timeouts are configurable back to Node
  defaults.
- **`exit(1)` on forced shutdown** may trigger restart-loop alerts in
  orchestrators that treat non-zero exit as a crash. Intentional: a drain that
  overran its deadline *is* abnormal and should be visible.
- **Compression and request limits do not interact**: compression shapes
  response bodies only; request-body size limits (`express.json` limit,
  `createSizeLimitMiddleware`) are unaffected. Called out because middleware
  ordering places compression first.
