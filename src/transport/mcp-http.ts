/**
 * Real MCP over HTTP: `POST/GET/DELETE /mcp` routed through the SDK's
 * `StreamableHTTPServerTransport`, one transport (and one `Server`, built
 * fresh via `buildMcpServer`) per session, keyed by the `Mcp-Session-Id`
 * header the SDK issues on `initialize`.
 *
 * See `openspec/changes/adopt-streamable-http-mcp-transport` design.md for
 * the routing rule and teardown contract this class implements.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type pino from 'pino';

import type { ToolContext } from '../tools/index.js';
import type { ResourceHandler } from '../resources/index.js';
import { buildMcpServer } from './mcp-server.js';
import { deriveTrustedClientId } from './middleware.js';

const SESSION_HEADER = 'mcp-session-id';

function isInitializeRequest(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const method = (body as { method?: unknown }).method;
  return method === 'initialize';
}

function sessionNotFound(res: Response): void {
  res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  });
}

/**
 * Owns the live `Mcp-Session-Id -> StreamableHTTPServerTransport` map for
 * one HTTP server instance. `createHttpServer` creates one of these per app
 * and registers the `/mcp` routes against it; `src/index.ts` calls
 * `closeAll()` on process shutdown.
 */
export class McpSessionManager {
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();

  constructor(
    private readonly ctx: ToolContext,
    private readonly resources: ResourceHandler,
    private readonly logger: pino.Logger,
  ) {}

  /** Number of live sessions — exposed for tests and health/metrics. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * `POST /mcp`: an `initialize` request (no session header yet) creates a
   * new session; every other request resolves the `Mcp-Session-Id` header
   * against the registry. A present-but-unknown id gets 404; the SDK
   * transport itself emits the 400 for a sessionless non-initialize POST
   * once handed to `handleRequest` (routing rule in design.md).
   */
  async handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = req.header(SESSION_HEADER);

    if (!sessionId) {
      if (isInitializeRequest(req.body)) {
        await this.createSession(req, res);
        return;
      }
      // No session id and not an initialize request: let the SDK transport
      // produce the spec-conformant 400 itself. A scratch, never-initialized
      // transport in *stateful* mode (sessionIdGenerator set) hits its own
      // `validateSession` "not initialized" branch and returns 400 without
      // ever needing a connected `Server` — stateless mode (sessionIdGenerator
      // undefined) would skip session validation entirely instead.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = this.sessions.get(sessionId);
    if (!transport) {
      sessionNotFound(res);
      return;
    }
    await transport.handleRequest(req, res, req.body);
  }

  /** `GET /mcp`: standalone SSE channel — registry lookup only. */
  async handleGet(req: Request, res: Response): Promise<void> {
    const sessionId = req.header(SESSION_HEADER);
    const transport = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!transport) {
      sessionNotFound(res);
      return;
    }
    await transport.handleRequest(req, res);
  }

  /** `DELETE /mcp`: terminates the named session — registry lookup only. */
  async handleDelete(req: Request, res: Response): Promise<void> {
    const sessionId = req.header(SESSION_HEADER);
    const transport = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!transport) {
      sessionNotFound(res);
      return;
    }
    await transport.handleRequest(req, res);
  }

  private async createSession(req: Request, res: Response): Promise<void> {
    const server = buildMcpServer(this.ctx, this.resources);
    const clientId = deriveTrustedClientId(req) ?? 'http-client';

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        this.sessions.set(sessionId, transport);
        this.logger.info({ event: 'mcp_session_opened', session_id: sessionId, client_id: clientId });
      },
      onsessionclosed: (sessionId: string) => {
        this.sessions.delete(sessionId);
        this.logger.info({ event: 'mcp_session_closed', session_id: sessionId });
      },
    });

    // Belt-and-suspenders: any other close path (transport error, peer
    // disconnect) also drops the map entry so a closed session can never
    // linger in the registry.
    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** Closes every live session's transport. Called on process shutdown. */
  async closeAll(): Promise<void> {
    const count = this.sessions.size;
    await Promise.all(Array.from(this.sessions.values()).map(transport => transport.close()));
    this.sessions.clear();
    this.logger.info({ event: 'mcp_sessions_teardown', count });
  }
}
