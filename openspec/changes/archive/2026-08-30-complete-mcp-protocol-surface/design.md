## Context

The stdio transport builds an SDK `Server` with hardcoded identity
(`src/index.ts:129`), minimal capabilities `{ tools: {}, resources: {} }`
(`src/index.ts:130`), and four request handlers (ListTools :133, CallTool :137,
ListResources :143 / templates :152, ReadResource :161). Tool definitions are a plain
array in `src/tools/schemas.ts` (13 tools, no titles/annotations/outputSchema).
`handleTool` (`src/tools/index.ts:60`) is transport-agnostic and converts *every*
failure — including "no such tool" (`src/tools/index.ts:129`) — into an error
envelope, which `buildToolCallResponse` (`src/transport/mcp-response.ts:24`) renders
as an `isError` tool result. The installed SDK is 1.27.1 (lockfile), which supports
everything needed here: `annotations`, `outputSchema`, prompts handlers,
`McpError`/`ErrorCode`, and `server.sendResourceListChanged()`.

## Goals / Non-Goals

Goals:
- Every tool advertises truthful behavioral hints; read-only tools stop looking
  destructive to spec-compliant clients.
- `structuredContent` (already emitted) becomes validatable for the three
  highest-traffic tools: `recall`, `search`, `remember`.
- Server identity, error taxonomy, capability declarations, and notifications match
  the MCP spec; payloads are compact.
- The bootstrap interview and session inject become discoverable via the prompts
  primitive instead of being tribal knowledge.

Non-Goals:
- No transport changes — the Streamable HTTP MCP transport is
  `adopt-streamable-http-mcp-transport`'s scope; the REST `/tool/:name` and
  `/resource` endpoints (`src/transport/http.ts:83/:97`) keep their current shapes.
- No outputSchema for the other ten tools in this change (their result unions are
  action-dependent; follow-up once envelopes are normalized).
- No `tools.listChanged` — the tool list is static.
- No elicitation/sampling primitives.

## Decisions

- **Annotation table** (openWorldHint is `false` for all 13 — every tool operates on
  the local store, never an open external domain):

  | tool | readOnly | destructive | idempotent | rationale |
  |---|---|---|---|---|
  | `remember` | false | false | false | additive upsert; dedup may UPDATE but never discards user data |
  | `recall` | true | — | — | pure read |
  | `forget` | false | true | true | hard delete; repeat delete adds nothing |
  | `search` | true | — | — | pure read |
  | `tag` | false | false | false | reversible metadata edit |
  | `collections` | false | true | false | `delete` with `force` cascades memory deletion (`src/tools/index.ts:477-505`) |
  | `category` | false | true | false | `delete` removes policy context; `set` overwrites (`:527/:536`) |
  | `backup` | false | true | false | `restore` overwrites both stores |
  | `bootstrap` | false | false | false | writes interview memories |
  | `import` | false | false | false | bulk additive writes |
  | `revisions` | false | true | false | `revert` overwrites current content |
  | `review` | false | false | false | archive is reversible via restore |
  | `repair` | false | false | true | reconstructive; safe to repeat |

  Per spec, `destructiveHint`/`idempotentHint` are meaningless when
  `readOnlyHint: true`, so read-only tools set only `readOnlyHint` + `openWorldHint`.
- **outputSchema scope**: `recall` and `search` declare
  `{ results: SearchResult[] }`-shaped schemas mirroring `src/domain/types.ts`.
  `remember` today returns `WriteResult | WriteResult[]`
  (`src/tools/index.ts:155`), and arrays are silently dropped from
  `structuredContent` (`src/transport/mcp-response.ts:30-32`) — declaring a schema
  over that union is impossible since `structuredContent` must be an object. So the
  MCP `CallTool` handler normalizes `remember` success results to
  `{ results: WriteResult[] }` (both text block and structuredContent) before
  `buildToolCallResponse`; the schema describes that envelope. The REST endpoint is
  untouched, keeping backward compatibility where clients already parse the old shape.
- **Version source**: a new `src/version.ts` resolves `package.json` relative to
  `import.meta.url` at startup (works from both `src/` under tsx and `dist/` after
  build, since `package.json` sits one level above either) and exports
  `PACKAGE_VERSION`; `src/index.ts:129` consumes it. No build-time codegen.
- **Unknown-tool guard**: `schemas.ts` exports a `MCP_TOOL_NAMES` set derived from
  `MCP_TOOL_DEFINITIONS`; the MCP CallTool handler throws
  `McpError(ErrorCode.InvalidParams, ...)` for names outside it *before* calling
  `handleTool`. `dispatch`'s default arm (`src/tools/index.ts:129`) stays as the REST
  path's envelope-producing backstop, and a unit test asserts the set and the
  `dispatch` cases stay in lockstep.
- **Prompts**: new `src/prompts/index.ts` exports `PROMPT_DEFINITIONS` and a handler.
  `bootstrap-interview` (optional `section` argument, validated against
  `TOTAL_SECTIONS`, `src/bootstrap/sections.ts:182`) returns instructions built from
  `BOOTSTRAP_SECTIONS` (`src/bootstrap/sections.ts:19`) directing the client through
  the `bootstrap` tool. `session-context` (optional `hint` argument) returns the
  `memory://inject` block (`src/resources/index.ts:378`) as a user-role message by
  calling the existing `ResourceHandler` — no duplicated budgeting logic. Capability
  `prompts: {}` (static list, no listChanged).
- **list_changed wiring**: `ToolContext` (`src/tools/index.ts:26`) gains an optional
  `notifyResourceListChanged?: () => void`. `handleCollections` invokes it after
  successful `create`/`delete` and `handleCategory` after `set`/`delete`. The stdio
  setup wires it to `server.sendResourceListChanged()` (fire-and-forget, errors
  logged at debug); the REST path leaves it undefined — a no-op. Memory writes do
  *not* notify: `memory://list` churn on every `remember` would spam clients for a
  paginated listing they rarely cache; scoped to the two enumerable taxonomy lists.
- **Compact JSON**: drop `null, 2` at `src/transport/mcp-response.ts:26` and
  `src/index.ts:168`. Human-readable pretty output was never a goal for machine
  consumers; REST responses via `res.json` were already compact.

## Risks / Trade-offs

- **`remember` MCP text-block shape changes** (single result now wrapped in
  `{ results: [...] }`): LLM clients re-read the JSON each call and adapt, but any
  brittle MCP-side parser breaks. Mitigated by version bump + README migration note;
  REST clients unaffected.
- **Annotations are hints, not enforcement** — a client may ignore them; classifying
  `review` as non-destructive is a judgment call (archive is reversible). The table
  lives in one place so reclassification is a one-line change.
- **Pretty→compact output** changes golden strings in existing tests
  (`mcp-response.test.ts`) and any user eyeballing raw stdio frames; negligible
  functional risk.
- **Notification fan-out** is best-effort: if `sendResourceListChanged` rejects (e.g.
  transport closed mid-shutdown), the mutation already succeeded — hence
  fire-and-forget with logging rather than failing the tool call.
- **Version helper file-read at startup** adds one synchronous read; trivial, and it
  fails loudly (throw) rather than silently reporting a wrong version.
