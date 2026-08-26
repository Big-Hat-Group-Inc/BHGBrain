## 1. Correct the OpenClaw / mcporter section

- [ ] 1.1 Replace the non-functional MCP-over-HTTP JSON block at `README.md:564-576` with a stdio configuration that connects, e.g. `openclaw mcp add bhgbrain --command bhgbrain-server --arg --stdio`, noting that secrets belong in the process environment rather than the client config file.
- [ ] 1.2 Retitle the section so it no longer advertises "HTTP transport" as the way MCP clients connect.

## 2. Describe the HTTP transport accurately

- [ ] 2.1 Document the HTTP surface as a REST interface over tools and resources, listing its actual routes as registered in `src/transport/http.ts`: `GET /health`, `POST /tool/:name`, `GET /resource`, and `GET /metrics` when `observability.metrics_enabled` is set.
- [ ] 2.2 State explicitly that this interface is not an MCP endpoint, does not implement JSON-RPC, streamable-http, or SSE, and cannot be registered as an MCP server.
- [ ] 2.3 Keep the existing curl examples - they are correct for the REST interface and demonstrate its intended use.

## 3. Correct the architecture diagram

- [ ] 3.1 Update the client-to-server edge label `MCP (stdio or HTTP)` at `README.md:68` so it does not assert MCP runs over HTTP.
- [ ] 3.2 Represent the REST interface as a distinct edge if the diagram is clearer for it, rather than folding it into the MCP edge.

## 4. Audit remaining references

- [ ] 4.1 Grep the README for every OpenClaw, mcporter, and HTTP-transport reference (including `README.md:3` and `:65`) and confirm none implies MCP over HTTP.
- [ ] 4.2 Check the Running the Server, Configuration, and Environment Variables sections for the same implication, particularly wording that presents HTTP mode as the default way clients connect.
- [ ] 4.3 Apply the equivalent corrections to `README.de.md`, `README.es.md`, `README.fr.md`, and `README.zh-CN.md`.

## 5. Validation

- [ ] 5.1 Confirm the documented stdio configuration connects from a real MCP client and lists the expected tools.
- [ ] 5.2 Confirm no remaining README block shows an MCP client pointed at the HTTP port.
- [ ] 5.3 Confirm the documented REST routes match `src/transport/http.ts` exactly, including that `/metrics` is conditional on `observability.metrics_enabled`.
