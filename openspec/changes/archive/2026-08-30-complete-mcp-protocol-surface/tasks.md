## 1. Server identity and capabilities

- [x] 1.1 Add `src/version.ts` exporting `PACKAGE_VERSION`, read from `package.json`
  resolved relative to `import.meta.url` (must work from both `src/` via tsx and
  `dist/` after build); replace the hardcoded `'1.4.0'` in the `Server` constructor
  (`src/index.ts:129`). Note: by the time this task landed, the `Server`
  construction had already moved to `src/transport/mcp-server.ts`
  (`adopt-streamable-http-mcp-transport`, shared by both stdio and HTTP
  transports) and the hardcoded literal there had drifted to `'1.12.0'` while
  `package.json` was at `1.16.0` — `MCP_SERVER_VERSION` in `mcp-server.ts` now
  aliases `PACKAGE_VERSION` instead of a literal.
- [x] 1.2 Extend the capabilities declaration (now in `src/transport/mcp-server.ts`,
  originally `src/index.ts:130`) to
  `{ tools: {}, resources: { listChanged: true }, prompts: {} }`.

## 2. Tool titles, annotations, and outputSchema

- [x] 2.1 Add `title` and `annotations` (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint: false`) to all 13 entries of
  `MCP_TOOL_DEFINITIONS` (`src/tools/schemas.ts:1-203`) per the classification table
  in `design.md`; read-only tools (`recall` :23, `search` :53) set only
  `readOnlyHint: true` + `openWorldHint: false`.
- [x] 2.2 Add `outputSchema` to `recall` (`src/tools/schemas.ts:23`) and `search`
  (`:53`) describing `{ results: SearchResult[] }` per `src/domain/types.ts`.
- [x] 2.3 Add `outputSchema` to `remember` (`src/tools/schemas.ts:3`) as
  `{ results: WriteResult[] }`, and normalize `remember`'s success result to that
  envelope in the MCP `CallTool` path only (now `src/transport/mcp-server.ts`,
  originally cited as `src/index.ts:137-141`) — `handleRemember`'s `single-or-array`
  return (`src/tools/index.ts:155`) and the REST `/tool/:name` response
  (`src/transport/http.ts:83`) stay as they are.
- [x] 2.4 Export a `MCP_TOOL_NAMES: ReadonlySet<string>` derived from
  `MCP_TOOL_DEFINITIONS` in `src/tools/schemas.ts`.

## 3. Protocol-correct unknown-tool errors

- [x] 3.1 In the MCP `CallTool` handler (`src/transport/mcp-server.ts`, originally
  cited as `src/index.ts:137-141`), throw `McpError(ErrorCode.InvalidParams, ...)`
  when `request.params.name` is not in `MCP_TOOL_NAMES`, before invoking
  `handleTool`; leave `dispatch`'s default arm (`src/tools/index.ts:129`) as the
  REST backstop.
- [x] 3.2 Unit test: every name in `MCP_TOOL_NAMES` has a `dispatch` case (call each
  with invalid args and assert the error is not `Unknown tool`), and an unknown name
  through the CallTool handler surfaces a JSON-RPC InvalidParams error, not an
  `isError` tool result. (`src/tools/schemas.test.ts`, `src/transport/mcp-server.test.ts`)

## 4. Prompts primitive

- [x] 4.1 Add `src/prompts/index.ts` with `MCP_PROMPT_DEFINITIONS` and a
  `handleGetPrompt` covering: `bootstrap-interview` (optional `section` arg validated
  against `TOTAL_SECTIONS`, `src/bootstrap/sections.ts:182`; messages built from
  `BOOTSTRAP_SECTIONS`, `src/bootstrap/sections.ts:19`, directing use of the
  `bootstrap` tool) and `session-context` (optional `hint` arg; returns the
  `memory://inject` block via the existing `ResourceHandler`,
  `src/resources/index.ts:378`). Unknown prompt names throw
  `McpError(ErrorCode.InvalidParams)`.
- [x] 4.2 Register `ListPromptsRequestSchema` / `GetPromptRequestSchema` handlers on
  the stdio `Server` (`src/index.ts:127-141` block). Note: registered in the shared
  `buildMcpServer` factory (`src/transport/mcp-server.ts`) instead, since that
  factory now builds the `Server` for *both* stdio (`src/index.ts`) and every
  per-session Streamable HTTP connection (`src/transport/mcp-http.ts`) — prompts are
  available on both transports, a superset of the original stdio-only ask.
- [x] 4.3 Tests for both prompts: definition listing, message content includes the
  interview sections / inject block, `section` out of range and unknown prompt name
  rejected. (`src/prompts/index.test.ts`, plus a listing/get round-trip in
  `src/transport/mcp-server.test.ts`)

## 5. Resource list_changed notifications

- [x] 5.1 Add optional `notifyResourceListChanged?: () => void` to `ToolContext`
  (`src/tools/index.ts:26-36`); invoke it after successful collection `create`
  (`src/tools/index.ts:468`) and `delete` (`:477`), and category `set`
  (`:527`) and `delete` (`:536`).
- [x] 5.2 Wire the stdio path to `server.sendResourceListChanged()` (fire-and-forget;
  rejection logged at debug, never fails the tool call); REST path leaves the hook
  undefined.
- [x] 5.3 Tests: mutating collection/category actions fire the hook exactly once;
  `list`/`get` actions and failed mutations do not; absent hook is a no-op.
  (`src/tools/index.test.ts`)

## 6. Compact JSON payloads

- [x] 6.1 Switch `buildToolCallResponse` to compact `JSON.stringify(result)`
  (`src/transport/mcp-response.ts:26`) and update `mcp-response.test.ts` golden
  strings. (No literal golden-string updates were needed — the existing assertions
  round-trip through `JSON.parse`, so they were indentation-agnostic already; the
  compact-output behavior itself is what changed.)
- [x] 6.2 Switch the `ReadResource` handler's text serialization to compact (now
  `src/transport/mcp-server.ts`, originally cited as `src/index.ts:168`).

## 7. Docs and validation

- [x] 7.1 README: add annotations/outputSchema notes and the `remember` MCP envelope
  migration note to § "MCP Tools Reference" (`README.md:2278`), document the two
  prompts and list_changed behavior (new § "MCP Prompts", new "Resource List Change
  Notifications" subsection under § "MCP Resources"); mirror in `README.de.md`,
  `README.es.md`, `README.fr.md`, `README.zh-CN.md`.
- [x] 7.2 Update `CLAUDE.md` § "MCP surface (canonical lists)" to add the prompts
  primitive (`src/prompts/index.ts`), and `AGENTS.md` structure listing (added
  `prompts/` and `version.ts`).
- [x] 7.3 Bump `package.json` version (user-visible MCP surface/behavior change) —
  1.16.0 → 1.17.0 — which the new `src/version.ts` now surfaces automatically in
  `serverInfo`.
- [x] 7.4 `npm run lint` and `npm test` pass.
