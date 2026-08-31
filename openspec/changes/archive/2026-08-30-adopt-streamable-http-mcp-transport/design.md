## Context

Today's transport split (`src/index.ts:126-185`): the stdio branch constructs one MCP
`Server`, registers five request handlers inline (tools list/call, resources
list/templates/read, `src/index.ts:133-171`), and connects a `StdioServerTransport`.
The HTTP branch calls `createHttpServer(config, ctx, resources, logger)` and gets a
plain Express app whose only routes are `/health`, `POST /tool/:name`,
`GET /resource`, and `/metrics` — no MCP framing at all. All the MCP-facing logic the
HTTP path needs (`handleTool`, `buildToolCallResponse`, `ResourceHandler.handle`,
`MCP_TOOL_DEFINITIONS`, `MCP_RESOURCE_DEFINITIONS/_TEMPLATES`) already exists and is
transport-agnostic; only the `Server` wiring is trapped inside the stdio branch.

The SDK's `StreamableHTTPServerTransport` (installed 1.27.1) is designed for exactly
this mount point: `handleRequest(req, res, parsedBody)` consumes Node
`IncomingMessage`/`ServerResponse` (Express-compatible), and stateful mode
(`sessionIdGenerator` provided) implements the spec's session rules itself — session
id issued on `initialize`, 404 for unknown ids, 400 for sessionless non-initialize
requests, `DELETE` terminates.

## Goals / Non-Goals

Goals:
- Real MCP over HTTP at `/mcp` so multiple MCP clients share one long-running server.
- One `buildMcpServer` factory shared verbatim by stdio and every HTTP session — zero
  behavioral drift between transports.
- Security parity: `/mcp` sits behind the same auth/rate-limit/size-limit chain as
  the REST endpoints.
- Deterministic teardown: sessions close on `DELETE` and on process shutdown.

Non-Goals:
- No resumability/event replay (`eventStore` stays unset) — nothing server-initiated
  is streamed today, so replay has nothing to replay.
- No OAuth/authorization-server support (SDK `auth` module) — bearer token via the
  existing middleware is unchanged.
- No expansion of the MCP surface itself (prompts, completions, annotations) — that
  is `complete-mcp-protocol-surface`.
- No removal or deprecation of `POST /tool/:name` / `GET /resource`.
- No backwards-compatible SSE transport (the pre-2025 `/sse` protocol revision).

## Decisions

- **Per-session `Server` + transport pair.** The SDK binds one `Server` to one
  transport, so each `initialize` builds a fresh `Server` from `buildMcpServer` and
  connects it to a new `StreamableHTTPServerTransport`. Handlers close over the same
  shared `ctx`/`resources` singletons, so sessions share state (the point of the
  change) while protocol state stays per-session.
- **Factory location: `src/transport/mcp-server.ts`.** Sibling of `http.ts` and
  `mcp-response.ts`, which already own MCP response shaping. `src/index.ts` shrinks
  to `buildMcpServer(ctx, resources)` + connect. The factory owns `serverInfo`; the
  stale hardcoded version (`'1.4.0'` at `src/index.ts:129` vs `package.json` 1.11.0)
  gets corrected to the bumped package version as part of the move.
- **Session registry lives in `src/transport/mcp-http.ts`**, created by
  `createHttpServer` and returned alongside the app (return shape becomes
  `{ app, mcpSessions }`). `index.ts` owns process lifecycle: SIGINT/SIGTERM handlers
  call `mcpSessions.closeAll()` before exit. Registration uses the transport's
  `onsessioninitialized` (add to map) and `onsessionclosed` + `onclose` (delete from
  map) callbacks, so the map can never leak a closed session.
- **Routing rule.** `POST /mcp`: if the body is an `initialize` request → new
  session; else look up `Mcp-Session-Id` header in the registry and delegate to that
  transport's `handleRequest` — the SDK emits the 400/404 protocol errors itself for
  missing/unknown ids. `GET /mcp` (standalone SSE channel) and `DELETE /mcp`
  (termination) do registry lookup only. Express's `express.json()` has already
  parsed POST bodies (`src/transport/http.ts:68`), so the body is forwarded as
  `handleRequest`'s `parsedBody` argument.
- **`enableJsonResponse: true`.** POST responses come back as plain JSON instead of a
  one-shot SSE stream. BHGBrain initiates no server-side messages mid-request
  (no sampling, no progress), so SSE-framed responses buy nothing, while JSON keeps
  curl debugging and supertest assertions straightforward. The standalone `GET /mcp`
  SSE channel still exists for spec-conformant clients that open it. Revisit if a
  future change streams progress notifications.
- **Session ids: `randomUUID`** from `node:crypto` as `sessionIdGenerator`
  (cryptographically random per SDK guidance).
- **DNS-rebinding options unused.** The SDK's `allowedHosts`/`allowedOrigins` are
  deprecated in favor of external middleware; BHGBrain's protections are the existing
  loopback-default binding, `validateLoopbackBinding`/`validateExternalAuthBinding`,
  and bearer auth — all already wrapping `/mcp`.
- **Middleware order untouched.** Routes register after
  `createAuthMiddleware`/`createRateLimitMiddleware`/`createSizeLimitMiddleware`
  (`src/transport/http.ts:78-80`); `GET /mcp` (SSE, no body) passes the size check
  trivially since it keys on `Content-Length`.

## Risks / Trade-offs

- **In-memory sessions don't survive restarts.** A restarted server 404s old session
  ids; spec-conformant clients respond by re-initializing. Accepted — matches the
  SDK's stateful-mode design and the single-process deployment model.
- **Session accumulation from clients that never DELETE.** Bounded in practice by
  auth + rate limiting, and each idle session holds only a small `Server` object (no
  sockets held outside active SSE streams). An idle-session TTL is a follow-up if
  real-world use shows growth; adding one now would risk killing live sessions of
  quiet clients.
- **Two live entry points to the same handlers** (REST + MCP) could drift. Mitigated
  by both delegating to the identical `handleTool`/`resources.handle` code paths —
  the new routes add framing, not logic.
- **`createHttpServer` return-shape change** (`app` → `{ app, mcpSessions }`) touches
  every existing call site and test setup; mechanical, covered by the type checker.
- **Parallel authoring overlap with `complete-mcp-protocol-surface`.** Both touch the
  `Server` construction site. The factory extraction here is deliberately the shared
  seam; whichever lands second rebases its handler registrations into the factory.
