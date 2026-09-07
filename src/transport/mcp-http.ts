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

function sessionCapacityExceeded(res: Response, maxSessions: number): void {
  res.status(503).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: `Server has reached its maximum MCP session capacity (${maxSessions})` },
    id: null,
  });
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  /** Refreshed on every request handled through this session — see `touch`. */
  lastSeenAt: number;
}

/**
 * Owns the live `Mcp-Session-Id -> StreamableHTTPServerTransport` map for
 * one HTTP server instance. `createHttpServer` creates one of these per app
 * and registers the `/mcp` routes against it; `src/index.ts` calls
 * `closeAll()` on process shutdown.
 *
 * bound-qdrant-http-runtime task 3.1-3.3: a client that abandons a session
 * without ever sending `DELETE /mcp` (the common case — see design.md
 * decision 3) used to leak its transport in `sessions` forever. Each entry
 * now carries a `lastSeenAt`, refreshed on every request handled through it;
 * an unref'd periodic sweep closes and removes sessions idle beyond
 * `config.transport.http.mcp_session.idle_timeout_ms`, and session creation
 * enforces `max_sessions` — evicting the single least-recently-active
 * session to make room, or answering 503 if the registry is empty and still
 * "at capacity" (a degenerate `max_sessions: 0` misconfiguration; ordinary
 * operation always has room to evict once at least one session exists).
 */
export class McpSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly ctx: ToolContext,
    private readonly resources: ResourceHandler,
    private readonly logger: pino.Logger,
  ) {
    const sweepIntervalMs = this.ctx.config.transport.http.mcp_session.sweep_interval_ms;
    // Unref'd so this timer never keeps the process alive on its own (matches
    // every other periodic timer in this codebase, e.g. CleanupScheduler).
    this.sweepTimer = setInterval(() => this.sweepIdleSessions(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Number of live sessions — exposed for tests and health/metrics. */
  get size(): number {
    return this.sessions.size;
  }

  private touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastSeenAt = Date.now();
    }
  }

  private updateActiveGauge(): void {
    this.ctx.metrics.setGauge('bhgbrain_mcp_sessions_active', this.sessions.size);
  }

  /**
   * Closes and removes every session idle beyond
   * `mcp_session.idle_timeout_ms`. Called on the unref'd sweep timer; also
   * reachable directly from `createSession`'s capacity check via
   * `evictOldestIdle` for an immediate, request-triggered reclaim.
   */
  private sweepIdleSessions(): void {
    const idleTimeoutMs = this.ctx.config.transport.http.mcp_session.idle_timeout_ms;
    const now = Date.now();
    const expired: string[] = [];
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastSeenAt >= idleTimeoutMs) {
        expired.push(sessionId);
      }
    }
    for (const sessionId of expired) {
      this.evictSession(sessionId, 'idle');
    }
  }

  /** Closes and removes one session, logging/counting the reason. Fire-and-forget close. */
  private evictSession(sessionId: string, reason: 'idle' | 'capacity'): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    this.ctx.metrics.incCounter('bhgbrain_mcp_sessions_evicted_total', 1, { reason });
    this.logger.info({ event: 'mcp_session_evicted', session_id: sessionId, reason });
    entry.transport.close().catch((err: unknown) => {
      this.logger.warn({ event: 'mcp_session_close_failed', session_id: sessionId, error: (err as Error).message });
    });
    this.updateActiveGauge();
  }

  /**
   * Evicts the single least-recently-active session to free capacity for a
   * new one. Returns false only when the registry is already empty (a
   * `max_sessions: 0` misconfiguration is the only way `createSession`'s
   * capacity check can reach this with nothing to evict).
   */
  private evictOldestIdle(): boolean {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastSeenAt < oldestAt) {
        oldestAt = entry.lastSeenAt;
        oldestId = sessionId;
      }
    }
    if (!oldestId) return false;
    this.evictSession(oldestId, 'capacity');
    return true;
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

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      sessionNotFound(res);
      return;
    }
    this.touch(sessionId);
    await entry.transport.handleRequest(req, res, req.body);
  }

  /** `GET /mcp`: standalone SSE channel — registry lookup only. */
  async handleGet(req: Request, res: Response): Promise<void> {
    const sessionId = req.header(SESSION_HEADER);
    const entry = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!entry) {
      sessionNotFound(res);
      return;
    }
    this.touch(sessionId!);
    await entry.transport.handleRequest(req, res);
  }

  /** `DELETE /mcp`: terminates the named session — registry lookup only. */
  async handleDelete(req: Request, res: Response): Promise<void> {
    const sessionId = req.header(SESSION_HEADER);
    const entry = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!entry) {
      sessionNotFound(res);
      return;
    }
    await entry.transport.handleRequest(req, res);
  }

  private async createSession(req: Request, res: Response): Promise<void> {
    // bound-qdrant-http-runtime task 3.2: enforce the resident-session cap
    // before creating a new one — evict the least-recently-active session to
    // make room, or fail closed with 503 if the registry has nothing to
    // evict (see `evictOldestIdle`'s doc comment).
    const maxSessions = this.ctx.config.transport.http.mcp_session.max_sessions;
    if (this.sessions.size >= maxSessions) {
      if (!this.evictOldestIdle()) {
        this.logger.warn({ event: 'mcp_session_capacity_exceeded', max_sessions: maxSessions });
        sessionCapacityExceeded(res, maxSessions);
        return;
      }
    }

    const server = buildMcpServer(this.ctx, this.resources);
    const clientId = deriveTrustedClientId(req) ?? 'http-client';

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        this.sessions.set(sessionId, { transport, lastSeenAt: Date.now() });
        this.logger.info({ event: 'mcp_session_opened', session_id: sessionId, client_id: clientId });
        this.updateActiveGauge();
      },
      onsessionclosed: (sessionId: string) => {
        this.sessions.delete(sessionId);
        this.logger.info({ event: 'mcp_session_closed', session_id: sessionId });
        this.updateActiveGauge();
      },
    });

    // Belt-and-suspenders: any other close path (transport error, peer
    // disconnect) also drops the map entry so a closed session can never
    // linger in the registry.
    transport.onclose = () => {
      if (transport.sessionId && this.sessions.delete(transport.sessionId)) {
        this.updateActiveGauge();
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** Closes every live session's transport and stops the idle sweep. Called on process shutdown. */
  async closeAll(): Promise<void> {
    clearInterval(this.sweepTimer);
    const count = this.sessions.size;
    await Promise.all(Array.from(this.sessions.values()).map(entry => entry.transport.close()));
    this.sessions.clear();
    this.updateActiveGauge();
    this.logger.info({ event: 'mcp_sessions_teardown', count });
  }
}
