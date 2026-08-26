## Context

BHGBrain exposes two network surfaces and the README conflates them.

The MCP surface is stdio only. `src/index.ts` wires the MCP SDK to a stdio transport under
`--stdio`, and that is what MCP clients connect to.

The HTTP surface (`src/transport/http.ts`) is a REST shim: `GET /health`, `POST /tool/:name`,
`GET /resource`, `GET /metrics`. It is genuinely useful - curl-able, scriptable, monitorable - but
it does not implement the MCP wire protocol. There is no JSON-RPC dispatch and no streamable-http
or SSE endpoint.

`README.md:564` presents an MCP client configuration pointing at the REST port. Anyone following
it gets a connection failure against a server that is running and healthy, with no diagnostic
pointing at the real cause. The `MCP (stdio or HTTP)` edge in the architecture diagram
(`README.md:68`) reinforces the same incorrect model.

## Goals / Non-Goals

**Goals:**
- Make the documented client configuration one that actually connects.
- Describe the HTTP transport as what it is, so its real value (health, metrics, scripted tool
  invocation) is clear.
- Remove the implication that MCP runs over HTTP, wherever it appears.
- Keep documentation consistent across all five README translations.

**Non-Goals:**
- Implementing MCP-over-HTTP (streamable-http or SSE). If wanted, that is a separate feature
  change with its own proposal.
- Removing, renaming, or deprecating the REST routes - they are useful and stay as they are.
- Changing the default transport or any server behavior.

## Decisions

1. Document reality rather than remove the section.
- Decision: keep an OpenClaw section, but show a stdio configuration that works, and retitle the
  HTTP material to describe the REST interface.
- Rationale: OpenClaw users need a working recipe. Deleting the section leaves them with nothing;
  leaving it leaves them with something wrong.
- Alternative considered: delete the OpenClaw section entirely. Rejected - OpenClaw is named as a
  supported client in the first line of the README (`README.md:3`).

2. State the limitation explicitly rather than merely omitting the wrong example.
- Decision: say directly that the HTTP transport is not an MCP endpoint and cannot be registered
  as an MCP server.
- Rationale: an HTTP port on an MCP server is a natural thing to assume is an MCP endpoint. Silence
  invites the reader to re-derive the original mistake.
- Alternative considered: quietly drop the JSON block. Rejected - the assumption survives.

3. Correct the architecture diagram in the same change.
- Decision: update the `MCP (stdio or HTTP)` edge at `README.md:68` so the transport claim matches
  the prose.
- Rationale: the diagram is read before the prose and makes the same false claim more memorably.

4. Treat the translated READMEs as in scope.
- Decision: apply the corrections to `README.de.md`, `README.es.md`, `README.fr.md`, and
  `README.zh-CN.md`.
- Rationale: a non-English reader following a stale translation hits exactly the same dead end.

## Risks / Trade-offs

- The translations may drift if updated mechanically without a reader of each language; where a
  faithful translation is not possible, the corrected English block is preferable to a confidently
  wrong translated one.
- Documenting stdio-only MCP may read as a capability regression to users who assumed HTTP worked.
  The section should note that MCP-over-HTTP is not currently implemented, so the limitation reads
  as a known boundary rather than a removal.
- Line numbers cited in tasks are from `main` at the time of writing and will drift; the audit step
  should re-grep for the claim rather than trusting the numbers.
