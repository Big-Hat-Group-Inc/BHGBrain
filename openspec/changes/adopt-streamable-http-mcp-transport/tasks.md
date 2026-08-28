## 1. Extract the MCP server factory

- [x] 1.1 Create `src/transport/mcp-server.ts` exporting
  `buildMcpServer(ctx: ToolContext, resources: ResourceHandler): Server` — move the
  `Server` construction and the five request-handler registrations verbatim from
  `src/index.ts:128-171` (ListTools → `MCP_TOOL_DEFINITIONS`, CallTool →
  `handleTool` + `buildToolCallResponse`, ListResources/ListResourceTemplates →
  `MCP_RESOURCE_DEFINITIONS`/`MCP_RESOURCE_TEMPLATES`, ReadResource →
  `resources.handle`). Each call returns a *fresh* `Server` (one per transport).
- [x] 1.2 Fix the `serverInfo` version while moving it: `src/index.ts:129` hardcodes
  `'1.4.0'` but `package.json` is at 1.11.0 — the factory declares the new bumped
  version (task 5.1) as the single source.
- [x] 1.3 Rewire the stdio branch (`src/index.ts:126-175`) to
  `buildMcpServer(ctx, resources)` + `StdioServerTransport` connect; behavior
  identical.

## 2. Session manager and /mcp routes

- [x] 2.1 Create `src/transport/mcp-http.ts` with an `McpSessionManager` holding
  `Map<sessionId, StreamableHTTPServerTransport>`: on an `initialize` POST it builds
  a `Server` via `buildMcpServer`, constructs a `StreamableHTTPServerTransport` with
  `sessionIdGenerator: randomUUID`, `enableJsonResponse: true`, and
  `onsessioninitialized`/`onsessionclosed` callbacks that add/remove map entries
  (also clear on `transport.onclose`); connects server to transport; then delegates
  to `transport.handleRequest(req, res, parsedBody)`.
- [x] 2.2 Non-initialize requests: resolve the `Mcp-Session-Id` header against the
  map and delegate to that transport's `handleRequest`; when the header is present
  but unknown respond 404 (JSON-RPC error body per SDK convention), and let the SDK
  transport emit the 400 for sessionless non-initialize POSTs.
- [x] 2.3 Register `POST /mcp`, `GET /mcp`, `DELETE /mcp` in `createHttpServer`
  (`src/transport/http.ts`) *after* the auth/rate-limit/size-limit middleware at
  `src/transport/http.ts:78-80`, forwarding `req.body` as `parsedBody` on POST
  (the global `express.json()` at `src/transport/http.ts:68` has already consumed
  the stream). Change the return shape to `{ app, mcpSessions }` and update the
  call site at `src/index.ts:178`.
- [x] 2.4 Teardown: `McpSessionManager.closeAll()` awaits `transport.close()` for
  every live session; `src/index.ts` HTTP branch registers SIGINT/SIGTERM handlers
  that call it (and stop the `CleanupScheduler` from `src/index.ts:115-116`) before
  closing the listener and exiting.
- [x] 2.5 Log session lifecycle through the existing pino logger: session opened
  (id, client ip via `deriveTrustedClientId`), session closed, teardown count —
  mirroring the `event:`-keyed structured style used in `src/transport/http.ts` and
  `src/index.ts`.

## 3. Tests

- [x] 3.1 Factory test (`src/transport/mcp-server.test.ts`): two `buildMcpServer`
  calls return distinct `Server` instances; CallTool and ReadResource handlers
  delegate to `handleTool`/`resources.handle` (mock `ToolContext` per the pattern in
  `src/transport/http.test.ts`).
- [x] 3.2 Session lifecycle test via supertest (no `.listen()`, per the existing
  `src/transport/http.test.ts` convention): POST `/mcp` with an `initialize`
  request returns the `Mcp-Session-Id` header and a JSON initialize result; a
  follow-up `tools/list` POST with that header succeeds.
- [x] 3.3 Protocol-error tests: unknown `Mcp-Session-Id` → 404; non-initialize POST
  without the header → 400; `DELETE /mcp` with a live session id closes it and a
  subsequent request with that id → 404.
- [x] 3.4 Security-parity test: with a bearer token configured, an unauthenticated
  POST `/mcp` gets 401 before any session is created; rate-limit middleware applies
  to `/mcp` (reuse the `resetForTests` hook from
  `src/transport/middleware.ts:64-67`).
- [x] 3.5 Teardown test: after `closeAll()`, the session map is empty and previously
  issued session ids return 404.
- [x] 3.6 Regression: existing `POST /tool/:name` and `GET /resource` tests in
  `src/transport/http.test.ts` still pass unchanged apart from the
  `{ app, mcpSessions }` destructuring.

## 4. Docs

- [x] 4.1 `README.md`: rewrite § "HTTP mode" (the "does **not** implement MCP
  Streamable HTTP" note near line 553 inverts), add `/mcp` rows to the endpoint
  table (~line 569), and replace the § "OpenClaw / mcporter (stdio transport)"
  framing (~lines 624-666) with Streamable-HTTP client config (URL
  `http://127.0.0.1:3721/mcp`, bearer token header) while keeping stdio as the
  spawn-per-client alternative; keep `/tool/:name` + `/resource` documented as the
  REST convenience layer.
- [x] 4.2 Mirror the same edits section-for-section in `README.de.md`,
  `README.es.md`, `README.fr.md`, `README.zh-CN.md`.
- [x] 4.3 `AGENTS.md`: update the "Dual Transport Support" bullet — HTTP mode now
  serves MCP Streamable HTTP at `/mcp` plus the REST endpoints.

## 5. Validation

- [x] 5.1 Bump `package.json` `version` (user-facing change) and align the factory's
  `serverInfo` version (task 1.2).
- [x] 5.2 `npm run lint` passes (tsc + eslint; no `any` casts in the new transport
  code).
- [x] 5.3 `npm test` passes, including both transport paths.
