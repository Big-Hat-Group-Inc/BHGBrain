> Line references verified 2026-08-28 against a working tree with
> `adopt-streamable-http-mcp-transport` partially applied (uncommitted). If that
> change has moved since, re-anchor by the cited function/handler names.

## 1. Config schema

- [ ] 1.1 Add `keep_alive_timeout_ms` (default 65000), `headers_timeout_ms`
  (default 66000), and `request_timeout_ms` (default 300000) to the
  `transport.http` Zod object (`src/config/index.ts:102-108`, currently only
  `enabled`/`host`/`port`/`bearer_token_env`), each `z.number().int().positive()`.
- [ ] 1.2 Add a `superRefine` enforcing `headers_timeout_ms >
  keep_alive_timeout_ms` with an actionable message (Node requires headers
  timeout to exceed keep-alive timeout to avoid ECONNRESET races).

## 2. Graceful shutdown

- [ ] 2.1 Extract a shared `createShutdown(...)` helper in `src/index.ts` and
  extend the existing HTTP-branch handler (`shutdown` closure,
  `src/index.ts:138-153`): on signal, immediately run `sqlite.flushIfDirty()`
  (`src/storage/sqlite.ts:432-434`), then the existing
  `mcpSessions.closeAll()` → `cleanupScheduler.stop()` → `httpServer.close()`
  sequence, and inside the close callback call `sqlite.close()`
  (`src/storage/sqlite.ts:1560-1564` — cancels the deferred-flush timer, flushes
  if dirty, closes the db) before `process.exit(0)`.
- [ ] 2.2 Arm a 10 s unref'd hard-deadline timer when shutdown starts: on
  expiry, log a `shutdown_timeout` event, run `sqlite.cancelDeferredFlush()` +
  `sqlite.flushIfDirty()` synchronously, and `process.exit(1)`.
- [ ] 2.3 Stdio branch (`src/index.ts:104-122`, currently registers no
  handlers): register the same SIGINT/SIGTERM shutdown (flush →
  `cleanupScheduler.stop()` → `sqlite.close()` → exit) and hook the
  `StdioServerTransport` close path (`server.onclose` / transport `onclose`) to
  the same teardown so a client closing stdin also persists state.
- [ ] 2.4 Keep the existing `shuttingDown` re-entrancy guard covering both the
  second signal and the deadline path; keep the structured `shutdown_start` /
  `shutdown_complete` log events and add the transport label.

## 3. JSON error envelope on every HTTP failure path

- [ ] 3.1 Add a terminal 4-arg error middleware in `createHttpServer`, after the
  route registrations and before the `return { app, mcpSessions }`
  (`src/transport/http.ts:140`): map `instanceof BrainError` →
  `err.toEnvelope()` (`src/errors/index.ts:13-21`) with a code→status map
  consistent with `src/transport/middleware.ts` (401/400/404/409/429/413);
  body-parser `entity.parse.failed` → 400 `INVALID_INPUT`;
  `entity.too.large` → 413 matching the `createSizeLimitMiddleware` envelope
  (`src/transport/middleware.ts:168`); everything else → 500
  `{error:{code:'INTERNAL', message:'An unexpected error occurred',
  retryable:true}}` (same body as `src/tools/index.ts:98`). Log the real error
  through pino; never put stack/message of unexpected errors in the response.
  If `res.headersSent`, delegate to `next(err)`.
- [ ] 3.2 Guard the resource URI parse: wrap `new URL(uri)` in
  `ResourceHandler.handle` (`src/resources/index.ts:38`) in try/catch and
  return an `INVALID_INPUT` envelope object on failure, matching the existing
  returned `NOT_FOUND` envelope for unknown schemes (`src/resources/index.ts:55`).
  This fixes the leak for stdio and `/mcp` readers too, where no Express
  middleware exists.
- [ ] 3.3 Add `ENV NODE_ENV=production` to the runtime stage of the `Dockerfile`
  (ENV block at `Dockerfile:27-29`) as defense in depth.

## 4. Server timeouts

- [ ] 4.1 After capturing the listener (`const httpServer = app.listen(...)`,
  `src/index.ts:129`), assign `httpServer.keepAliveTimeout`,
  `httpServer.headersTimeout`, and `httpServer.requestTimeout` from the new
  `config.transport.http` keys.

## 5. Security headers and compression

- [ ] 5.1 In `createHttpServer` (`src/transport/http.ts:67`, right after
  `express()`): `app.disable('x-powered-by')` and a middleware setting
  `X-Content-Type-Options: nosniff` on every response.
- [ ] 5.2 Add `compression` + `@types/compression` to `package.json` and
  `app.use` it before the routes with a `filter` that declines
  `text/event-stream` responses (the `/mcp` SSE stream must not be buffered);
  defer to the default filter otherwise.

## 6. Tests

- [ ] 6.1 Shutdown-persistence test: a `SqliteStore` with a pending deferred
  flush (dirty, timer armed via `scheduleDeferredFlush`) persists its state
  when the shutdown sequence runs `close()`; `flushIfDirty` after `close` is
  not required for the data to be present on a fresh load from disk.
- [ ] 6.2 Error-middleware tests in `src/transport/http.test.ts` (supertest, no
  `.listen()`): malformed JSON body to `POST /tool/remember` → 400
  `{error:{code:'INVALID_INPUT',...}}`; `GET /resource?uri=not-a-url` → 400
  envelope, body contains no stack trace and `Content-Type` is JSON, not HTML;
  a route that throws a generic `Error` → 500 `INTERNAL` envelope with the
  generic message only.
- [ ] 6.3 Header tests: responses carry no `X-Powered-By` and carry
  `X-Content-Type-Options: nosniff`.
- [ ] 6.4 Compression test: a large JSON response with `Accept-Encoding: gzip`
  comes back compressed; a `text/event-stream` response does not.
- [ ] 6.5 Timeout wiring test: with custom `transport.http` timeout config, the
  created `http.Server`'s `keepAliveTimeout`/`headersTimeout`/`requestTimeout`
  match; Zod rejects `headers_timeout_ms <= keep_alive_timeout_ms`.

## 7. Docs and validation

- [ ] 7.1 `README.md`: document the three new `transport.http` config keys, the
  graceful-shutdown behavior (drain, flush, 10 s deadline, exit codes), and the
  JSON error envelope guarantee; note `NODE_ENV=production` in the container
  image section.
- [ ] 7.2 Mirror the same edits section-for-section in `README.de.md`,
  `README.es.md`, `README.fr.md`, `README.zh-CN.md`.
- [ ] 7.3 Bump `package.json` `version` (user-facing: new config keys, changed
  error responses and shutdown semantics). `.env.example` unchanged — no new
  env vars.
- [ ] 7.4 `npm run lint` and `npm test` pass.
