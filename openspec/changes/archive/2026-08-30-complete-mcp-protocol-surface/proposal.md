## Why

The MCP surface works but is spec-incomplete in ways clients can see:

- The 13 tool definitions in `src/tools/schemas.ts:1-203` carry no `title`, no
  `annotations`, and no `outputSchema`. Under the MCP spec's annotation defaults
  (`readOnlyHint: false`, `destructiveHint: true`), a client must treat `recall` and
  `search` as being exactly as dangerous as `forget` — every read prompts like a
  delete. And although `buildToolCallResponse` already emits `structuredContent`
  (`src/transport/mcp-response.ts:24-33`), no tool declares the schema that would let
  clients validate it.
- `serverInfo` hardcodes `version: '1.4.0'` (`src/index.ts:129`) while `package.json`
  is at `1.11.0` — clients and diagnostics see a version seven minors stale.
- An unknown tool name flows through `dispatch`'s default arm
  (`src/tools/index.ts:129` → `invalidInput`), is caught by `handleTool`
  (`src/tools/index.ts:84-92`), and comes back as an `isError` *tool result*. The MCP
  spec requires unknown tools to fail as JSON-RPC protocol errors (`-32602`,
  InvalidParams) — execution errors and protocol errors are deliberately distinct.
- The bootstrap interview (10 sections, `src/bootstrap/sections.ts:19`) is a textbook
  fit for the MCP **prompts** primitive, but the server declares no `prompts`
  capability and registers no prompt handlers (`src/index.ts:130`).
- Collection and category mutations (`src/tools/index.ts:468/477` and `:527/:536`)
  change what `collection://list` / `category://list` enumerate, but the server never
  sends `notifications/resources/list_changed`, so connected clients cache stale lists.
- Every MCP payload is pretty-printed with 2-space indent
  (`src/transport/mcp-response.ts:26`, `src/index.ts:168`), inflating LLM-consumed
  JSON by roughly 20-40% for zero benefit.

## What Changes

- Add `title`, behavioral `annotations` (`readOnlyHint` / `destructiveHint` /
  `idempotentHint` / `openWorldHint: false`), and — for `recall`, `search`, and
  `remember` — `outputSchema` to `MCP_TOOL_DEFINITIONS`, per the classification table
  in `design.md`.
- Normalize `remember`'s MCP result envelope to a stable `{ results: WriteResult[] }`
  shape so its `outputSchema` holds for both single- and multi-candidate writes (the
  HTTP REST `/tool/:name` endpoint keeps its current shape).
- Read the `serverInfo` version from `package.json` via a small version helper instead
  of the hardcoded `'1.4.0'`.
- Reject unknown tool names in the MCP `CallTool` handler with
  `McpError(ErrorCode.InvalidParams)` before dispatch; valid tools that fail keep
  returning `isError` tool results.
- Register a `prompts` capability with two prompts: `bootstrap-interview` (drives the
  10-section onboarding interview via the `bootstrap` tool) and `session-context`
  (returns the budgeted `memory://inject` block for session priming).
- Declare `resources: { listChanged: true }` and send
  `notifications/resources/list_changed` after collection create/delete and category
  set/delete, via an optional notifier hook on `ToolContext` wired only by the stdio
  transport.
- Switch MCP text payloads to compact `JSON.stringify` in `buildToolCallResponse` and
  the `ReadResource` handler.

## Capabilities

### New Capabilities
- `mcp-protocol-surface`: The MCP server surface is protocol-complete — annotated,
  schema-described tools; truthful server identity; spec-correct protocol errors;
  prompts for onboarding and session context; resource change notifications; and
  compact wire payloads.

### Modified Capabilities

## Impact

- Affected code: `src/tools/schemas.ts` (annotations/titles/outputSchema),
  `src/index.ts` (serverInfo, capabilities, CallTool guard, prompt handlers,
  notification wiring, compact resource reads), `src/transport/mcp-response.ts`
  (compact JSON, remember envelope), new `src/version.ts` and `src/prompts/index.ts`,
  `src/tools/index.ts` (`ToolContext` notifier hook), co-located tests.
- Behavior: MCP clients see titles/annotations/outputSchema, a real version, protocol
  errors for unknown tools, two prompts, list_changed notifications, and compact JSON.
  The HTTP REST endpoints (`/tool/:name`, `/resource`) are untouched — `res.json` is
  already compact and keeps the legacy `remember` shape.
- Docs: README ×5 (MCP Tools Reference + new Prompts section), `CLAUDE.md` MCP-surface
  canonical lists (prompts primitive added), version bump. `.env.example` unchanged.
- Depends on: nothing. Complements `adopt-streamable-http-mcp-transport` (the
  transport itself, proposed separately) — everything here lands on the shared
  `Server` surface both transports serve.
