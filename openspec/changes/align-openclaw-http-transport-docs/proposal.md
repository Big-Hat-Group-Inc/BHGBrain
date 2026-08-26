# Align OpenClaw / HTTP transport documentation with the shipped transport

## Why

`README.md:564` documents an "OpenClaw / mcporter (HTTP transport)" configuration:

```json
{
  "mcpServers": {
    "bhgbrain": {
      "transport": "http",
      "url": "http://127.0.0.1:3721",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

This configuration cannot work, because the HTTP transport is not an MCP transport.
`src/transport/http.ts` registers exactly four routes - `GET /health`, `POST /tool/:name`,
`GET /resource`, and (conditionally) `GET /metrics`. There is no JSON-RPC endpoint, no
`initialize` / `tools/list` / `tools/call` method dispatch, no `StreamableHTTPServerTransport`,
and no SSE endpoint. It is a REST convenience shim over the tool layer.

MCP clients do not speak that shape. OpenClaw, for instance, accepts only `streamable-http` or
`sse` for HTTP MCP servers (`openclaw mcp add --transport <type>`); there is no `http` transport
value, and pointing either supported value at port 3721 fails to connect because no MCP endpoint
is listening. Verified against OpenClaw 2026.7.1-2 on 2026-08-25 - stdio is the only transport
that connects to BHGBrain today.

The README is the user-facing contract per `CLAUDE.md`. As written, it sends integrators down a
path that cannot succeed, and the failure mode is opaque: the server is running and `/health`
answers, so the client reports a connection error against an apparently healthy server.

The architecture diagram compounds this. `README.md:68` labels the client-to-server edge
`MCP (stdio or HTTP)`, which asserts the same thing at a glance.

## What Changes

- Correct the "OpenClaw / mcporter (HTTP transport)" section so it no longer presents a
  non-functional MCP client configuration. Document stdio as the transport MCP clients use, with a
  working OpenClaw example.
- Describe the HTTP transport accurately as a REST interface over tools and resources, with its
  actual routes, and state plainly that it is not an MCP endpoint and cannot be registered as an
  MCP server.
- Correct the architecture diagram edge at `README.md:68` so it does not claim MCP runs over HTTP.
- Audit the remaining OpenClaw and HTTP-transport references (`README.md:3`, `:65`, and the
  Running the Server / Configuration sections) for the same claim, and align the translated
  READMEs (`README.de.md`, `README.es.md`, `README.fr.md`, `README.zh-CN.md`).
- Documentation-only change: no source behavior is modified.

## Capabilities

### New Capabilities

- `http-transport-doc-accuracy`: user-facing documentation SHALL describe the HTTP transport as
  the REST interface it is, SHALL NOT present it as an MCP transport or show MCP client
  configurations pointing at it, and SHALL document a client configuration that actually connects.

### Modified Capabilities

(none)

## Impact

- Affected docs: `README.md` (OpenClaw/mcporter section, architecture diagram, HTTP transport
  prose) and the four translated READMEs.
- Affected code: none.
- Affected specs: adds `http-transport-doc-accuracy`.
- Risk: minimal - documentation correction only.
- Note: this proposal deliberately does not propose *implementing* MCP-over-HTTP. If serving MCP
  over HTTP is wanted, that is a separate feature change (adding a streamable-http or SSE
  endpoint), and the docs should describe reality until it exists.
