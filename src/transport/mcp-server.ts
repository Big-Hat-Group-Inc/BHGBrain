/**
 * Builds a fresh MCP `Server` wired to the shared tool/resource handlers.
 *
 * Both transports (stdio in `src/index.ts` and every per-session HTTP
 * transport in `src/transport/mcp-http.ts`) construct their `Server` through
 * this factory so behavior never drifts between them — each call returns a
 * brand-new `Server` instance since the SDK binds exactly one `Server` to one
 * transport connection. See `openspec/changes/adopt-streamable-http-mcp-transport`.
 */

import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

import type { ResourceHandler } from '../resources/index.js';
import { MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_TEMPLATES } from '../resources/index.js';
import { handleTool, type ToolContext } from '../tools/index.js';
import { MCP_TOOL_DEFINITIONS, MCP_TOOL_NAMES } from '../tools/schemas.js';
import { MCP_PROMPT_DEFINITIONS, handleGetPrompt } from '../prompts/index.js';
import { buildToolCallResponse, isErrorEnvelope } from './mcp-response.js';
import type { WriteResult, ErrorCode as DomainErrorCode } from '../domain/types.js';
import { PACKAGE_VERSION } from '../version.js';

// Single source of truth for the MCP `serverInfo.version` field, kept in
// sync with `package.json` via `src/version.ts` (task 1.1/1.2 — the prior
// hardcoded '1.4.0' at the old src/index.ts:129, then '1.12.0' here, had
// drifted from the real package version; reading it at startup means a
// version bump needs no code edit).
export const MCP_SERVER_VERSION = PACKAGE_VERSION;

/**
 * Maps a classified `ErrorCode` (domain/types.ts) to the MCP protocol error
 * code that best conveys the same failure over `ReadResourceRequestSchema`
 * (task 2.3) — mirrors the REST `ERROR_STATUS` mapping in
 * src/errors/index.ts, just targeting the MCP SDK's own error enum instead
 * of an HTTP status.
 */
function mcpErrorCodeFor(code: DomainErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT':
      return ErrorCode.InvalidParams;
    case 'NOT_FOUND':
      return ErrorCode.InvalidRequest;
    case 'AUTH_REQUIRED':
    case 'RATE_LIMITED':
    case 'CONFLICT':
    case 'EMBEDDING_UNAVAILABLE':
    case 'INTERNAL':
    default:
      return ErrorCode.InternalError;
  }
}

/**
 * `remember`'s handler returns `WriteResult | WriteResult[]` (single object
 * for one candidate, array when multi-candidate extraction splits content).
 * `structuredContent` must be an object, so a bare array is silently dropped
 * by `buildToolCallResponse` and no `outputSchema` can describe a union.
 * This normalizes a successful `remember` result to a stable
 * `{ results: WriteResult[] }` envelope on the MCP path only — the REST
 * `/tool/:name` endpoint and `handleRemember`'s return type are untouched
 * (task 2.3).
 */
function normalizeRememberResult(toolName: string, result: unknown): unknown {
  if (toolName !== 'remember' || isErrorEnvelope(result)) {
    return result;
  }
  const results: WriteResult[] = Array.isArray(result)
    ? (result as WriteResult[])
    : [result as WriteResult];
  return { results };
}

/**
 * Options threading request/session correlation into a built `Server`
 * (strengthen-operational-observability task 1.5/design.md decision 1:
 * "MCP uses session ID plus a per-call ID; trusted client identity is
 * passed into `buildMcpServer` and child loggers").
 */
export interface BuildMcpServerOptions {
  /**
   * Base logger for this server instance — a session-scoped child logger
   * (carrying `session_id`/`client_id`) for the Streamable HTTP transport
   * (see `src/transport/mcp-http.ts`'s `createSession`), or the process-wide
   * logger for stdio, where there is exactly one long-lived connection per
   * process. Defaults to `ctx.logger`.
   */
  logger?: pino.Logger;
  /** Trusted client identity (HTTP: the derived socket/forwarded IP; stdio: unknown — a single local client). Defaults to 'unknown'. */
  clientId?: string;
}

/**
 * Constructs a new MCP `Server` with the ListTools/CallTool/ListResources/
 * ListResourceTemplates/ReadResource handlers registered against the given
 * `ctx`/`resources`. Callers connect the returned server to whichever
 * `Transport` is appropriate (stdio, or a per-session
 * `StreamableHTTPServerTransport`).
 */
export function buildMcpServer(ctx: ToolContext, resources: ResourceHandler, options?: BuildMcpServerOptions): Server {
  const baseLogger = options?.logger ?? ctx.logger;
  const clientId = options?.clientId ?? 'unknown';

  const server = new Server(
    { name: 'bhgbrain', version: MCP_SERVER_VERSION },
    { capabilities: { tools: {}, resources: { listChanged: true }, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    // Unknown tool names are a protocol error (JSON-RPC -32602 InvalidParams),
    // not a tool-execution failure — thrown before `handleTool` so it never
    // reaches `dispatch`'s REST-oriented `isError` envelope path (task 3.1).
    if (!MCP_TOOL_NAMES.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    // strengthen-operational-observability task 1.5: a per-call id on top of
    // the session-scoped base logger, so two concurrent calls on the same
    // MCP session (or the same stdio connection) still produce
    // distinguishable `tool_call`/`tool_error` log lines. `baseLogger` is
    // optional-chained rather than assumed present so a caller that omits
    // `ctx.logger` entirely (a bare test double) still gets a well-defined
    // `undefined` — `handleTool` itself falls back to `ctx.logger` in that
    // case, exactly as it did before this call ever passed a logger through.
    const callLogger = baseLogger?.child({ call_id: randomUUID() });
    const result = await handleTool(ctx, name, toolArgs, clientId, callLogger);
    return buildToolCallResponse(normalizeRememberResult(name, result));
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: MCP_PROMPT_DEFINITIONS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: promptArgs } = request.params;
    return handleGetPrompt(resources, name, promptArgs);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: MCP_RESOURCE_DEFINITIONS.map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: 'application/json',
    })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: MCP_RESOURCE_TEMPLATES.map(r => ({
      uriTemplate: r.uriTemplate,
      name: r.name,
      description: r.description,
      mimeType: 'application/json',
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const result = await resources.handle(uri);
    // `ResourceHandler.handle` reports failures (unknown scheme, malformed
    // URI, not found, ...) by *returning* an error-envelope object rather
    // than throwing (see resources/index.ts) — the REST `/resource` route
    // already maps that shape to an HTTP status. Over MCP, the equivalent
    // native failure signal is a protocol-level error, not `contents`
    // holding the JSON-stringified envelope as if it were successful data;
    // without this, a NOT_FOUND resource read looked identical to a
    // successful one to an MCP client (align-runtime-entrypoint-contracts
    // task 2.3).
    if (isErrorEnvelope(result)) {
      throw new McpError(mcpErrorCodeFor(result.error.code), result.error.message);
    }
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(result),
      }],
    };
  });

  return server;
}
