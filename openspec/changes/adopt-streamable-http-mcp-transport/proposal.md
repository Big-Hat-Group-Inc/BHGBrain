## Why

The default HTTP mode is not an MCP transport. `createHttpServer` exposes a bespoke
REST shim — `POST /tool/:name` (`src/transport/http.ts:83-94`) and `GET /resource`
(`src/transport/http.ts:97-105`) — with no JSON-RPC dispatch, no initialize handshake,
no sessions, and no SSE. The README says so outright ("it is *not* an MCP Streamable
HTTP endpoint, so MCP clients cannot connect to it", § OpenClaw / mcporter), a
concession formalized by `align-openclaw-http-transport-docs`.

The consequence defeats the product's core value: every MCP client must spawn its own
`--stdio` child process (`src/index.ts:126-175`), so a "shared brain" degenerates into
one isolated server process per client, each separately hydrating SQLite and racing on
the same data dir. A long-running HTTP server that real MCP clients can attach to is
the whole point of having an HTTP mode.

The fix is nearly free: the installed `@modelcontextprotocol/sdk` (1.27.1) ships
`StreamableHTTPServerTransport` (`server/streamableHttp.js`) with built-in
`Mcp-Session-Id` session management — stateful mode generates the session id on
`initialize`, rejects unknown sessions with 404 and sessionless non-initialize
requests with 400 — and its `handleRequest(req, res, parsedBody)` mounts directly on
the existing Express app, behind the existing auth, rate-limit, and size-limit
middleware (`src/transport/http.ts:78-80`).

## What Changes

- Extract the stdio-path MCP `Server` wiring (`src/index.ts:128-171` — serverInfo,
  ListTools/CallTool/ListResources/ListResourceTemplates/ReadResource handlers) into a
  reusable `buildMcpServer(ctx, resources)` factory; the stdio branch and every HTTP
  session both build servers through it.
- Add `POST /mcp`, `GET /mcp`, and `DELETE /mcp` routes in `createHttpServer`, routed
  by `Mcp-Session-Id` to per-session `StreamableHTTPServerTransport` instances: an
  `initialize` request creates a new session (and a fresh `Server` via the factory);
  a request bearing an unknown session id gets 404; a non-initialize request with no
  session id gets 400 (both enforced by the SDK transport).
- Track live sessions in a session registry with clean teardown: `DELETE /mcp` closes
  that session; process shutdown closes every transport before exit.
- The `/mcp` routes sit *behind* the existing bearer-auth, rate-limit, and size-limit
  middleware — MCP-over-HTTP inherits the HTTP surface's security posture unchanged.
- Keep `POST /tool/:name` and `GET /resource` exactly as they are, documented as the
  REST convenience layer for non-MCP callers (curl, scripts).
- Update `README.md` (§ HTTP mode, § OpenClaw / mcporter, endpoint table) plus the
  four translations: HTTP mode now *is* an MCP endpoint; show client config for
  Streamable HTTP. Bump `package.json` version.

## Capabilities

### New Capabilities
- `streamable-http-transport`: The HTTP server speaks real MCP via the Streamable
  HTTP transport at `/mcp`, with per-session server instances keyed by
  `Mcp-Session-Id`, protected by the existing HTTP auth and rate limiting, torn down
  cleanly on session end and process shutdown — alongside the retained REST
  convenience endpoints.

### Modified Capabilities

## Impact

- Affected code: `src/index.ts` (extract factory, shutdown hooks), new
  `src/transport/mcp-server.ts` (factory) and session wiring in
  `src/transport/http.ts`, co-located tests (`src/transport/http.test.ts` plus new
  factory/session tests).
- Behavior: additive — three new `/mcp` routes; existing REST endpoints, stdio mode,
  and middleware order are unchanged. Multiple MCP clients can now share one
  long-running server process.
- Docs: README ×5 (HTTP mode is currently documented as *not* MCP — that text
  inverts), version bump. `.env.example` unchanged (no new env vars; no new config
  keys — `/mcp` is a fixed path on the existing `transport.http` listener).
- Relationship: complements the sibling proposal `complete-mcp-protocol-surface`
  (annotations/prompts/capabilities — what the server *says* over MCP); this change is
  the transport itself (how clients *reach* it). The shared `buildMcpServer` factory
  is the natural seam between them. Independent of both; no ordering constraint.
