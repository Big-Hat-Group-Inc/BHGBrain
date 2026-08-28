/**
 * Builds a fresh MCP `Server` wired to the shared tool/resource handlers.
 *
 * Both transports (stdio in `src/index.ts` and every per-session HTTP
 * transport in `src/transport/mcp-http.ts`) construct their `Server` through
 * this factory so behavior never drifts between them — each call returns a
 * brand-new `Server` instance since the SDK binds exactly one `Server` to one
 * transport connection. See `openspec/changes/adopt-streamable-http-mcp-transport`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { ResourceHandler } from '../resources/index.js';
import { MCP_RESOURCE_DEFINITIONS, MCP_RESOURCE_TEMPLATES } from '../resources/index.js';
import { handleTool, type ToolContext } from '../tools/index.js';
import { MCP_TOOL_DEFINITIONS } from '../tools/schemas.js';
import { buildToolCallResponse } from './mcp-response.js';

// Single source of truth for the MCP `serverInfo.version` field, kept in
// sync with `package.json` (task 1.2 / 5.1 — the prior hardcoded '1.4.0' at
// the old src/index.ts:129 had drifted from the real package version).
export const MCP_SERVER_VERSION = '1.12.0';

/**
 * Constructs a new MCP `Server` with the ListTools/CallTool/ListResources/
 * ListResourceTemplates/ReadResource handlers registered against the given
 * `ctx`/`resources`. Callers connect the returned server to whichever
 * `Transport` is appropriate (stdio, or a per-session
 * `StreamableHTTPServerTransport`).
 */
export function buildMcpServer(ctx: ToolContext, resources: ResourceHandler): Server {
  const server = new Server(
    { name: 'bhgbrain', version: MCP_SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    const result = await handleTool(ctx, name, toolArgs);
    return buildToolCallResponse(result);
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
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(result, null, 2),
      }],
    };
  });

  return server;
}
