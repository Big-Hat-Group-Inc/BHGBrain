import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { BrainConfig } from '../config/index.js';

const handleToolMock = vi.fn();

vi.mock('../tools/index.js', () => ({
  handleTool: handleToolMock,
}));

describe('createHttpServer', () => {
  function createConfig(
    metricsEnabled = false,
    authRequired = true,
    overrides?: { trustProxy?: boolean; rateLimitRpm?: number },
  ): BrainConfig {
    return {
      data_dir: 'test-data',
      embedding: { provider: 'openai', model: 'test-model', api_key_env: 'OPENAI_API_KEY', dimensions: 3 },
      qdrant: { mode: 'embedded', embedded_path: './qdrant', external_url: null, api_key_env: null },
      transport: {
        http: {
          enabled: true,
          host: '127.0.0.1',
          port: 3721,
          bearer_token_env: 'BHGBRAIN_TOKEN',
          keep_alive_timeout_ms: 65000,
          headers_timeout_ms: 66000,
          request_timeout_ms: 300000,
        },
        stdio: { enabled: true },
      },
      defaults: {
        namespace: 'global',
        collection: 'general',
        recall_limit: 5,
        min_score: 0.6,
        auto_inject_limit: 10,
        max_response_chars: 50000,
      },
      retention: {
        decay_after_days: 180,
        max_db_size_gb: 2,
        max_memories: 500000,
        warn_at_percent: 80,
        tier_ttl: { T0: null, T1: 365, T2: 90, T3: 30 },
        tier_budgets: { T0: null, T1: 100000, T2: 200000, T3: 200000 },
        auto_promote_access_threshold: 5,
        sliding_window_enabled: true,
        archive_before_delete: true,
        cleanup_schedule: '0 2 * * *',
        scheduled_cleanup_enabled: true,
        pre_expiry_warning_days: 7,
        compaction_deleted_threshold: 0.1,
        audit_log_max_entries: 50000,
        revisions_per_memory_max: 20,
      },
      deduplication: { enabled: true, similarity_threshold: 0.92 },
      resilience: {
        circuit_breaker: {
          failure_threshold: 1,
          open_window_ms: 30000,
          half_open_probe_count: 1,
        },
      },
      search: { hybrid_weights: { semantic: 0.7, fulltext: 0.3 } },
      security: {
        require_loopback_http: true,
        allow_unauthenticated_http: !authRequired,
        log_redaction: true,
        rate_limit_rpm: overrides?.rateLimitRpm ?? 100,
        max_request_size_bytes: 1048576,
        trust_proxy: overrides?.trustProxy ?? false,
      },
      auto_inject: { max_chars: 30000, max_tokens: null },
      observability: { metrics_enabled: metricsEnabled, structured_logging: true, log_level: 'info' },
      pipeline: {
        extraction_enabled: true,
        extraction_model: 'gpt-4o-mini',
        extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
        fallback_to_threshold_dedup: true,
      },
      auto_summarize: true,
    };
  }

  // Builds the Express app in-process. Requests are dispatched via
  // supertest(app), which never calls `.listen()` on the app under test and
  // requires no port bookkeeping or connection-teardown plumbing (see
  // design decision "Use supertest ... never call .listen() in tests" and
  // audit follow-up 8.9).
  async function buildApp(config: BrainConfig, overrides?: {
    health?: { check: () => Promise<unknown> };
    metrics?: Partial<{
      getMetrics: () => Array<{ name: string; value: number }>;
      incCounter: (name: string, amount?: number) => void;
      setGauge: (name: string, value: number) => void;
      recordHistogram: (name: string, value: number) => void;
    }>;
    resources?: { handle: (uri: string) => Promise<unknown> };
  }) {
    process.env.BHGBRAIN_TOKEN = 'secret-token';
    handleToolMock.mockClear();

    const { createHttpServer } = await import('./http.js');
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const defaultMetrics = {
      getMetrics: vi.fn(() => []),
      incCounter: vi.fn(),
      setGauge: vi.fn(),
      recordHistogram: vi.fn(),
    };
    const ctx = {
      health: overrides?.health ?? { check: vi.fn(async () => ({ status: 'healthy' })) },
      metrics: { ...defaultMetrics, ...overrides?.metrics },
    };
    const resources = overrides?.resources ?? { handle: vi.fn(async (uri: string) => ({ uri })) };

    const { app, mcpSessions } = createHttpServer(
      config,
      ctx as never,
      resources as never,
      logger as never,
    );

    return { app, resources, mcpSessions };
  }

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.BHGBRAIN_TOKEN;
  });

  it('returns health without auth and uses 200/503 based on status', async () => {
    const healthy = await buildApp(createConfig(false, true), {
      health: { check: vi.fn(async () => ({ status: 'healthy' })) },
    });
    const healthyResponse = await request(healthy.app).get('/health');
    expect(healthyResponse.status).toBe(200);

    const unhealthy = await buildApp(createConfig(false, true), {
      health: { check: vi.fn(async () => ({ status: 'unhealthy' })) },
    });
    const unhealthyResponse = await request(unhealthy.app).get('/health');
    expect(unhealthyResponse.status).toBe(503);
  });

  it('returns 200 (not 503) when health reports degraded', async () => {
    // Covers http.ts:31 — the `degraded` branch, distinct from the
    // `unhealthy`->503 path above (audit follow-up 8.8 / task 2.3).
    const degraded = await buildApp(createConfig(false, true), {
      health: { check: vi.fn(async () => ({ status: 'degraded' })) },
    });
    const degradedResponse = await request(degraded.app).get('/health');
    expect(degradedResponse.status).toBe(200);
    expect(degradedResponse.body.status).toBe('degraded');
  });

  it('rejects tool calls without or with invalid auth', async () => {
    const { app } = await buildApp(createConfig(false, true));

    const missingAuth = await request(app)
      .post('/tool/remember')
      .set('Content-Type', 'application/json')
      .send({ content: 'hello' });
    expect(missingAuth.status).toBe(401);

    const invalidAuth = await request(app)
      .post('/tool/remember')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer wrong-token')
      .send({ content: 'hello' });
    expect(invalidAuth.status).toBe(401);
  });

  it('calls handleTool and resources when authorized', async () => {
    handleToolMock.mockResolvedValue({ ok: true });
    const resourcesHandle = vi.fn(async () => ({ resource: true }));
    const { app } = await buildApp(createConfig(false, true), {
      resources: { handle: resourcesHandle },
    });

    const toolResponse = await request(app)
      .post('/tool/remember')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer secret-token')
      // A caller-supplied x-client-id is an untrusted hint only — it must
      // never become the recorded audit/client identity (task 4.4).
      .set('x-client-id', 'client-1')
      .send({ content: 'hello' });
    expect(toolResponse.status).toBe(200);
    expect(toolResponse.body).toEqual({ ok: true });
    // The recorded client id is derived from the authenticated principal
    // (req.ip, a loopback address here), not from the spoofable
    // `x-client-id` header value 'client-1'.
    const [, , , recordedClientId] = handleToolMock.mock.calls[0] as [unknown, unknown, unknown, string];
    expect(recordedClientId).not.toBe('client-1');
    expect(recordedClientId).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);

    const missingUri = await request(app)
      .get('/resource')
      .set('Authorization', 'Bearer secret-token');
    expect(missingUri.status).toBe(400);

    const resourceResponse = await request(app)
      .get('/resource')
      .query({ uri: 'memory://list' })
      .set('Authorization', 'Bearer secret-token');
    expect(resourceResponse.status).toBe(200);
    expect(resourceResponse.body).toEqual({ resource: true });
    expect(resourcesHandle).toHaveBeenCalledWith('memory://list');
  });

  it('serves metrics only when enabled', async () => {
    const disabled = await buildApp(createConfig(false, true));
    const disabledResponse = await request(disabled.app)
      .get('/metrics')
      .set('Authorization', 'Bearer secret-token');
    expect(disabledResponse.status).toBe(404);

    const enabled = await buildApp(createConfig(true, true), {
      metrics: {
        getMetrics: vi.fn(() => [
          { name: 'bhgbrain_tool_handler_ms_p95', value: 12 },
          { name: 'search_total_ms_p95', value: 5 },
        ]),
      },
    });
    const enabledResponse = await request(enabled.app)
      .get('/metrics')
      .set('Authorization', 'Bearer secret-token');
    expect(enabledResponse.status).toBe(200);
    expect(enabledResponse.text).toContain('bhgbrain_tool_handler_ms_p95 12');
  });

  it('renders labels in Prometheus form and emits # TYPE lines (task 4.3)', async () => {
    const enabled = await buildApp(createConfig(true, true), {
      metrics: {
        getMetrics: vi.fn(() => [
          { name: 'bhgbrain_tool_calls_total', type: 'counter', value: 7 },
          {
            name: 'bhgbrain_tool_handler_ms_p95',
            type: 'histogram',
            value: 12,
            labels: { tool: 'recall', status: 'ok' },
          },
          {
            name: 'bhgbrain_tool_handler_ms_p95',
            type: 'histogram',
            value: 40,
            labels: { tool: 'remember', status: 'error' },
          },
        ] as never),
      },
    });

    const response = await request(enabled.app)
      .get('/metrics')
      .set('Authorization', 'Bearer secret-token');

    expect(response.status).toBe(200);
    const lines = response.text.split('\n');

    // One # TYPE line per metric name, not per label set.
    expect(lines).toContain('# TYPE bhgbrain_tool_calls_total counter');
    expect(lines).toContain('# TYPE bhgbrain_tool_handler_ms_p95 histogram');
    expect(lines.filter(l => l === '# TYPE bhgbrain_tool_handler_ms_p95 histogram')).toHaveLength(1);

    // Labels render as Prometheus `name{k="v",...} value` form.
    expect(lines).toContain('bhgbrain_tool_calls_total 7');
    expect(lines).toContain('bhgbrain_tool_handler_ms_p95{tool="recall",status="ok"} 12');
    expect(lines).toContain('bhgbrain_tool_handler_ms_p95{tool="remember",status="error"} 40');
  });

  it('ignores X-Forwarded-For for rate-limit identity when trust_proxy is disabled', async () => {
    const { app } = await buildApp(
      createConfig(false, true, { trustProxy: false, rateLimitRpm: 1 }),
    );

    const first = await request(app)
      .post('/tool/remember')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer secret-token')
      .set('X-Forwarded-For', '203.0.113.1')
      .send({ content: 'hello' });
    expect(first.status).toBe(200);

    // Different spoofed forwarding header, but with trust proxy disabled the
    // limiter must key on the real loopback socket peer for both requests,
    // so this second request from the "same" real client is rate-limited.
    const second = await request(app)
      .post('/tool/remember')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer secret-token')
      .set('X-Forwarded-For', '203.0.113.2')
      .send({ content: 'hello' });
    expect(second.status).toBe(429);
  });

  it('derives rate-limit identity from X-Forwarded-For when trust_proxy is enabled', async () => {
    const { app } = await buildApp(
      createConfig(false, true, { trustProxy: true, rateLimitRpm: 1 }),
    );

    const clientA = await request(app)
      .post('/tool/remember')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer secret-token')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ content: 'hello' });
    expect(clientA.status).toBe(200);

    // Distinct forwarded client identity is tracked in a distinct bucket, so
    // it is not rate-limited by client A's request.
    const clientB = await request(app)
      .post('/tool/remember')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer secret-token')
      .set('X-Forwarded-For', '203.0.113.20')
      .send({ content: 'hello' });
    expect(clientB.status).toBe(200);
  });

  // harden-http-server-lifecycle task 6.2: every HTTP failure path returns
  // the structured {error:{code,message,retryable}} envelope, never an HTML
  // stack trace, regardless of the failure's source (body-parser, a thrown
  // TypeError inside a resource handler, or an arbitrary route error).
  describe('JSON error envelope on every HTTP failure path (task 6.2)', () => {
    it('malformed JSON body to a tool endpoint returns a 400 INVALID_INPUT envelope', async () => {
      const { app } = await buildApp(createConfig(false, true));

      const response = await request(app)
        .post('/tool/remember')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer secret-token')
        .send('{not valid json');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: { code: 'INVALID_INPUT', message: expect.any(String), retryable: false },
      });
      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('GET /resource?uri=not-a-url returns a 400 envelope with no stack trace and a JSON content type', async () => {
      // ResourceHandler.handle itself is unit-tested against a real
      // `new URL(uri)` failure in resources/index.test.ts (task 3.2); this
      // test is about the HTTP layer mapping the INVALID_INPUT envelope it
      // returns onto an actual 400 status line, so the mock reproduces that
      // return-not-throw contract directly.
      const resourcesHandle = vi.fn(async (uri: string) =>
        ({ error: { code: 'INVALID_INPUT', message: `Malformed resource URI: ${uri}`, retryable: false } }));
      const { app } = await buildApp(createConfig(false, true), {
        resources: { handle: resourcesHandle },
      });

      const response = await request(app)
        .get('/resource')
        .query({ uri: 'not-a-url' })
        .set('Authorization', 'Bearer secret-token');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: { code: 'INVALID_INPUT', message: expect.any(String), retryable: false },
      });
      expect(response.headers['content-type']).toMatch(/json/);
      expect(JSON.stringify(response.body)).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack-trace frames
    });

    it('a route handler that throws a generic Error returns a 500 INTERNAL envelope with only the generic message', async () => {
      const resourcesHandle = vi.fn(async () => {
        throw new Error('boom: something exploded deep in a handler');
      });
      const { app } = await buildApp(createConfig(false, true), {
        resources: { handle: resourcesHandle },
      });

      const response = await request(app)
        .get('/resource')
        .query({ uri: 'memory://list' })
        .set('Authorization', 'Bearer secret-token');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: { code: 'INTERNAL', message: 'An unexpected error occurred', retryable: true },
      });
      // The real error message/stack must never reach the response body.
      expect(JSON.stringify(response.body)).not.toContain('boom');
    });
  });

  // harden-http-server-lifecycle task 6.3: header hygiene.
  describe('security headers (task 6.3)', () => {
    it('sends no X-Powered-By and sends X-Content-Type-Options: nosniff', async () => {
      const { app } = await buildApp(createConfig(false, true));

      const response = await request(app).get('/health');

      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  // harden-http-server-lifecycle task 6.4: compression respects SSE.
  describe('compression (task 6.4)', () => {
    it('compresses a large JSON response when the client sends Accept-Encoding: gzip', async () => {
      const largeMetrics = Array.from({ length: 2000 }, (_, i) => ({
        name: `bhgbrain_metric_${i}`,
        type: 'counter' as const,
        value: i,
      }));
      const { app } = await buildApp(createConfig(true, true), {
        metrics: { getMetrics: vi.fn(() => largeMetrics as never) },
      });

      const response = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer secret-token')
        .set('Accept-Encoding', 'gzip');

      expect(response.headers['content-encoding']).toBe('gzip');
    });

    // Driving a real long-lived `text/event-stream` response through the app
    // end-to-end would hang supertest (an SSE response never completes on
    // its own), so this exercises the filter directly instead — the same
    // function `app.use(compression({ filter }))` is wired to above.
    it('declines to compress a text/event-stream response', async () => {
      const { compressionFilter } = await import('./http.js');
      const res = { getHeader: () => 'text/event-stream' } as unknown as import('express').Response;
      expect(compressionFilter({} as import('express').Request, res)).toBe(false);
    });

    it('defers to the default filter for a compressible content type', async () => {
      const { compressionFilter } = await import('./http.js');
      const res = { getHeader: () => 'application/json; charset=utf-8' } as unknown as import('express').Response;
      expect(compressionFilter({} as import('express').Request, res)).toBe(true);
    });
  });

  // harden-http-server-lifecycle task 6.5 (first half — Zod rejection is
  // covered in config/index.test.ts): the socket-timeout config keys land on
  // the real `http.Server`, not merely on the config object.
  describe('applyHttpServerTimeouts (task 6.5)', () => {
    it("sets keepAliveTimeout/headersTimeout/requestTimeout from config.transport.http", async () => {
      const { applyHttpServerTimeouts } = await import('./http.js');
      const { createServer } = await import('node:http');

      const config = createConfig(false, true);
      config.transport.http.keep_alive_timeout_ms = 12345;
      config.transport.http.headers_timeout_ms = 23456;
      config.transport.http.request_timeout_ms = 34567;

      const server = createServer();
      applyHttpServerTimeouts(server, config);

      expect(server.keepAliveTimeout).toBe(12345);
      expect(server.headersTimeout).toBe(23456);
      expect(server.requestTimeout).toBe(34567);

      server.close();
    });
  });

// Real MCP over HTTP (Streamable HTTP transport) at /mcp — session
// lifecycle, protocol errors, security parity, and teardown (tasks 3.2-3.5).
describe('createHttpServer /mcp routes', () => {
  const MCP_ACCEPT = 'application/json, text/event-stream';

  function initializeBody(id: number | string = 1) {
    return {
      jsonrpc: '2.0' as const,
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      },
    };
  }

  function toolsListBody(id: number | string = 2) {
    return { jsonrpc: '2.0' as const, id, method: 'tools/list', params: {} };
  }

  async function initializeSession(app: import('express').Express, token = 'secret-token') {
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send(initializeBody());
    return res;
  }

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.BHGBRAIN_TOKEN;
  });

  it('creates a session on initialize and accepts a follow-up request with the session id (3.2)', async () => {
    const { app } = await buildApp(createConfig(false, true));

    const initRes = await initializeSession(app);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();
    expect(initRes.body.result.serverInfo.name).toBe('bhgbrain');

    const listRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', 'Bearer secret-token')
      .set('mcp-session-id', sessionId)
      .send(toolsListBody());
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.result.tools)).toBe(true);
  });

  it('rejects an unknown session id with 404 and a sessionless non-initialize POST with 400 (3.3)', async () => {
    const { app } = await buildApp(createConfig(false, true));

    const unknown = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', 'Bearer secret-token')
      .set('mcp-session-id', 'this-session-does-not-exist')
      .send(toolsListBody());
    expect(unknown.status).toBe(404);

    const missing = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', 'Bearer secret-token')
      .send(toolsListBody());
    expect(missing.status).toBe(400);
  });

  it('DELETE /mcp closes a session and a subsequent request with that id 404s (3.3)', async () => {
    const { app } = await buildApp(createConfig(false, true));

    const initRes = await initializeSession(app);
    const sessionId = initRes.headers['mcp-session-id'];

    const deleteRes = await request(app)
      .delete('/mcp')
      .set('Authorization', 'Bearer secret-token')
      .set('mcp-session-id', sessionId);
    expect(deleteRes.status).toBeLessThan(300);

    const afterDelete = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', 'Bearer secret-token')
      .set('mcp-session-id', sessionId)
      .send(toolsListBody());
    expect(afterDelete.status).toBe(404);
  });

  it('requires auth before a session is created and applies rate limiting to /mcp (3.4)', async () => {
    const { app: authApp } = await buildApp(createConfig(false, true));
    const unauthenticated = await request(authApp)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .send(initializeBody());
    expect(unauthenticated.status).toBe(401);

    const { app: limitedApp } = await buildApp(
      createConfig(false, true, { rateLimitRpm: 1 }),
    );
    const first = await initializeSession(limitedApp);
    expect(first.status).toBe(200);

    const second = await request(limitedApp)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', 'Bearer secret-token')
      .send(initializeBody(2));
    expect(second.status).toBe(429);
  });

  it('closeAll() empties the session registry and previously issued ids 404 (3.5)', async () => {
    const { app, mcpSessions } = await buildApp(createConfig(false, true));

    const initRes = await initializeSession(app);
    const sessionId = initRes.headers['mcp-session-id'];
    expect(mcpSessions.size).toBe(1);

    await mcpSessions.closeAll();
    expect(mcpSessions.size).toBe(0);

    const afterTeardown = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .set('Authorization', 'Bearer secret-token')
      .set('mcp-session-id', sessionId)
      .send(toolsListBody());
    expect(afterTeardown.status).toBe(404);
  });
});
});
