import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Server as HttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BrainConfig } from '../config/index.js';

const handleToolMock = vi.fn();

vi.mock('../tools/index.js', () => ({
  handleTool: handleToolMock,
}));

describe('createHttpServer', () => {
  function createConfig(
    metricsEnabled = false,
    authRequired = true,
    overrides?: {
      trustProxy?: false | number | string[];
      rateLimitRpm?: number;
      mcpSession?: { idle_timeout_ms?: number; max_sessions?: number; sweep_interval_ms?: number };
    },
  ): BrainConfig {
    return {
      data_dir: 'test-data',
      embedding: { provider: 'openai', model: 'test-model', api_key_env: 'OPENAI_API_KEY', dimensions: 3 },
      qdrant: {
        mode: 'embedded',
        embedded_path: './qdrant',
        external_url: null,
        api_key_env: null,
        operation_timeout_ms: 10_000,
        health_timeout_ms: 3_000,
        fanout: { max_collections: 25, concurrency: 5, per_target_limit: 50 },
      },
      transport: {
        http: {
          enabled: true,
          host: '127.0.0.1',
          port: 3721,
          bearer_token_env: 'BHGBRAIN_TOKEN',
          keep_alive_timeout_ms: 65000,
          headers_timeout_ms: 66000,
          request_timeout_ms: 300000,
          mcp_session: {
            idle_timeout_ms: overrides?.mcpSession?.idle_timeout_ms ?? 30 * 60_000,
            max_sessions: overrides?.mcpSession?.max_sessions ?? 1000,
            sweep_interval_ms: overrides?.mcpSession?.sweep_interval_ms ?? 60_000,
          },
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
        rate_limit_max_buckets: 10_000,
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
      // See the identical cast in embedding/index.test.ts's createConfig:
      // this fixture only needs the sections the HTTP transport tests
      // actually exercise (auth, rate limiting, MCP session bounds, etc.).
    } as unknown as BrainConfig;
  }

  // Builds the Express app in-process. Requests are dispatched via
  // supertest(app), which never calls `.listen()` on the app under test and
  // requires no port bookkeeping or connection-teardown plumbing (see
  // design decision "Use supertest ... never call .listen() in tests" and
  // audit follow-up 8.9).
  async function buildApp(config: BrainConfig, overrides?: {
    health?: { check: () => Promise<unknown>; checkLiveness?: () => unknown; checkReadiness?: () => Promise<unknown> };
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
    const logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; child: ReturnType<typeof vi.fn> } = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      // strengthen-operational-observability task 1.5: the request-context
      // and MCP-session middleware both derive a child logger via
      // `.child(...)` — self-referential so `logger.warn`/etc. assertions
      // below still see calls made through a derived child.
      child: vi.fn(() => logger),
    };

    const defaultMetrics = {
      getMetrics: vi.fn(() => []),
      incCounter: vi.fn(),
      setGauge: vi.fn(),
      recordHistogram: vi.fn(),
    };
    const ctx = {
      config,
      health: {
        check: vi.fn(async () => ({ status: 'healthy' })),
        checkLiveness: vi.fn(() => ({ status: 'ok', uptime_seconds: 1 })),
        checkReadiness: vi.fn(async () => ({ ready: true, components: { sqlite: { status: 'healthy' }, qdrant: { status: 'healthy' } } })),
        ...overrides?.health,
      },
      metrics: { ...defaultMetrics, ...overrides?.metrics },
    };
    const resources = overrides?.resources ?? { handle: vi.fn(async (uri: string) => ({ uri })) };

    const { app, mcpSessions } = createHttpServer(
      config,
      ctx as never,
      resources as never,
      logger as never,
    );

    return { app, resources, mcpSessions, metrics: ctx.metrics };
  }

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.BHGBRAIN_TOKEN;
  });

  // bound-qdrant-http-runtime task 2.1: the full diagnostic snapshot at
  // `/health` now requires the same Bearer auth as every other route.
  it('requires auth for the diagnostic /health snapshot and uses 200/503 based on status', async () => {
    const healthy = await buildApp(createConfig(false, true), {
      health: { check: vi.fn(async () => ({ status: 'healthy' })) },
    });
    const unauthenticated = await request(healthy.app).get('/health');
    expect(unauthenticated.status).toBe(401);

    const healthyResponse = await request(healthy.app).get('/health').set('Authorization', 'Bearer secret-token');
    expect(healthyResponse.status).toBe(200);

    const unhealthy = await buildApp(createConfig(false, true), {
      health: { check: vi.fn(async () => ({ status: 'unhealthy' })) },
    });
    const unhealthyResponse = await request(unhealthy.app).get('/health').set('Authorization', 'Bearer secret-token');
    expect(unhealthyResponse.status).toBe(503);
  });

  it('returns 200 (not 503) when the diagnostic snapshot reports degraded', async () => {
    // Covers http.ts's degraded branch, distinct from the unhealthy->503
    // path above (audit follow-up 8.8 / task 2.3).
    const degraded = await buildApp(createConfig(false, true), {
      health: { check: vi.fn(async () => ({ status: 'degraded' })) },
    });
    const degradedResponse = await request(degraded.app).get('/health').set('Authorization', 'Bearer secret-token');
    expect(degradedResponse.status).toBe(200);
    expect(degradedResponse.body.status).toBe('degraded');
  });

  // bound-qdrant-http-runtime task 2.1/2.2: liveness/readiness split.
  describe('/health/live and /health/ready (task 2.1/2.2)', () => {
    it('serves /health/live without auth, without rate limiting, and with no dependency I/O', async () => {
      const checkLiveness = vi.fn(() => ({ status: 'ok' as const, uptime_seconds: 42 }));
      const { app } = await buildApp(createConfig(false, true, { rateLimitRpm: 1 }), {
        health: { check: vi.fn(), checkLiveness, checkReadiness: vi.fn() },
      });

      // Exhaust the (very low) rate limit budget first...
      await request(app).get('/health/live');
      // ...liveness still succeeds every time, since it is registered ahead
      // of both auth and rate limiting.
      const response = await request(app).get('/health/live');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok', uptime_seconds: 42 });
      expect(checkLiveness).toHaveBeenCalled();
    });

    it('serves /health/ready without auth but maps ready:false to 503', async () => {
      const { app } = await buildApp(createConfig(false, true), {
        health: {
          check: vi.fn(),
          checkLiveness: vi.fn(),
          checkReadiness: vi.fn(async () => ({
            ready: false,
            components: { sqlite: { status: 'healthy' }, qdrant: { status: 'unhealthy', message: 'Qdrant unreachable' } },
          })),
        },
      });

      const response = await request(app).get('/health/ready');
      expect(response.status).toBe(503);
      expect(response.body.ready).toBe(false);
    });

    it('rate-limits repeated /health/ready probes (task 2.2)', async () => {
      const checkReadiness = vi.fn(async () => ({ ready: true, components: { sqlite: { status: 'healthy' }, qdrant: { status: 'healthy' } } }));
      const { app } = await buildApp(createConfig(false, true, { rateLimitRpm: 1 }), {
        health: { check: vi.fn(), checkLiveness: vi.fn(), checkReadiness },
      });

      const first = await request(app).get('/health/ready');
      expect(first.status).toBe(200);

      const second = await request(app).get('/health/ready');
      expect(second.status).toBe(429);
    });
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

  it('maps a classified tool failure to its HTTP status instead of always answering 200 (task 2.2)', async () => {
    // mockResolvedValueOnce, not mockResolvedValue: this mock is shared
    // module-wide across every test in this file (no per-test reset), so a
    // persistent override would leak into later tests expecting a
    // successful response.
    handleToolMock.mockResolvedValueOnce({ error: { code: 'NOT_FOUND', message: 'Memory abc not found', retryable: false } });
    const { app } = await buildApp(createConfig(false, true));

    const res = await request(app)
      .post('/tool/forget')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer secret-token')
      .send({ id: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Memory abc not found', retryable: false } });
  });

  it('maps a resource read error envelope to its HTTP status on GET /resource (task 2.2)', async () => {
    const resourcesHandle = vi.fn(async () => ({
      error: { code: 'NOT_FOUND', message: 'Memory xyz not found', retryable: false },
    }));
    const { app } = await buildApp(createConfig(false, true), {
      resources: { handle: resourcesHandle },
    });

    const res = await request(app)
      .get('/resource')
      .query({ uri: 'memory://xyz' })
      .set('Authorization', 'Bearer secret-token');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('serves metrics when enabled, or an explicit disabled explanation (not an unexplained 404) otherwise (task 2.4)', async () => {
    const disabled = await buildApp(createConfig(false, true));
    const disabledResponse = await request(disabled.app)
      .get('/metrics')
      .set('Authorization', 'Bearer secret-token');
    // The route is registered either way — a disabled install answers 503
    // with the reason, never the generic "route not found" 404 a caller
    // cannot distinguish from a typo'd path.
    expect(disabledResponse.status).toBe(503);
    expect(disabledResponse.body).toMatchObject({ metrics_enabled: false });
    expect(disabledResponse.body.message).toMatch(/metrics_enabled/);

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

  it('derives rate-limit identity from X-Forwarded-For when trust_proxy is enabled (one trusted hop)', async () => {
    const { app } = await buildApp(
      createConfig(false, true, { trustProxy: 1, rateLimitRpm: 1 }),
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

  // bound-qdrant-http-runtime task 2.3: `trust_proxy: true` ("trust every
  // hop") let a caller-supplied left-most X-Forwarded-For entry choose its
  // own client identity even through exactly one real reverse-proxy hop. A
  // positive hop count fixes this: only the right-most (nearest-to-server)
  // untrusted entry is authoritative, so a spoofed left-most prefix cannot
  // manufacture a fresh rate-limit identity.
  it('resists a spoofed left-most X-Forwarded-For entry behind a one-hop trusted proxy', async () => {
    const { app } = await buildApp(
      createConfig(false, true, { trustProxy: 1, rateLimitRpm: 1 }),
    );

    // Both requests arrive "through" the same real one-hop proxy (same
    // right-most/nearest entry, 9.9.9.9) but with different attacker-supplied
    // left-most prefixes. With only one hop trusted, req.ip resolves to the
    // right-most entry both times — the same identity — so the second
    // request is rate-limited rather than getting a fresh bucket.
    const first = await request(app)
      .post('/tool/remember')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer secret-token')
      .set('X-Forwarded-For', '203.0.113.1, 9.9.9.9')
      .send({ content: 'hello' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/tool/remember')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer secret-token')
      .set('X-Forwarded-For', '203.0.113.2, 9.9.9.9')
      .send({ content: 'hello' });
    expect(second.status).toBe(429);
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

  // bound-qdrant-http-runtime task 3.1-3.3: MCP session lifecycle bounds.
  describe('MCP session lifecycle bounds (bound-qdrant-http-runtime tasks 3.1-3.3)', () => {
    // Every test here uses a short idle_timeout_ms/sweep_interval_ms so its
    // idle sweep fires within the test's own real-timer wait. Several tests
    // deliberately leave a session alive at the end (e.g. "activity postpones
    // idle expiry"); without closeAll() here that session's unref'd sweep
    // timer keeps running with real timers into whichever test runs next,
    // eventually evicting it there — a leaked-timer cross-test leak that
    // strengthen-verification-and-code-boundaries task 2.2's "closed exactly
    // once" test below would otherwise observe as spurious extra close()
    // calls unrelated to the scenario it's asserting on.
    const builtSessionManagers: Array<{ closeAll: () => Promise<void> }> = [];
    async function buildTrackedApp(...args: Parameters<typeof buildApp>): ReturnType<typeof buildApp> {
      const built = await buildApp(...args);
      builtSessionManagers.push(built.mcpSessions);
      return built;
    }

    afterEach(async () => {
      await Promise.all(builtSessionManagers.map(m => m.closeAll()));
      builtSessionManagers.length = 0;
    });

    it('evicts the oldest session to make room once at max_sessions capacity', async () => {
      const { app, mcpSessions, metrics } = await buildTrackedApp(
        createConfig(false, true, { mcpSession: { max_sessions: 1 } }),
      );

      const firstInit = await initializeSession(app);
      const firstSessionId = firstInit.headers['mcp-session-id'];
      expect(mcpSessions.size).toBe(1);

      // A second initialize while already at capacity (max_sessions: 1)
      // evicts the first (only, hence oldest) session rather than growing
      // the registry past its cap or refusing the new client outright.
      const secondInit = await initializeSession(app);
      expect(secondInit.status).toBe(200);
      const secondSessionId = secondInit.headers['mcp-session-id'];
      expect(mcpSessions.size).toBe(1);
      expect(secondSessionId).not.toBe(firstSessionId);

      // The evicted session is gone from the registry.
      const afterEviction = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', MCP_ACCEPT)
        .set('Authorization', 'Bearer secret-token')
        .set('mcp-session-id', firstSessionId)
        .send(toolsListBody());
      expect(afterEviction.status).toBe(404);

      // The newly created session still works.
      const stillWorks = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', MCP_ACCEPT)
        .set('Authorization', 'Bearer secret-token')
        .set('mcp-session-id', secondSessionId)
        .send(toolsListBody());
      expect(stillWorks.status).toBe(200);

      expect(metrics.incCounter).toHaveBeenCalledWith(
        'bhgbrain_mcp_sessions_evicted_total', 1, { reason: 'capacity' },
      );
      expect(metrics.setGauge).toHaveBeenCalledWith('bhgbrain_mcp_sessions_active', 1);
    });

    it('closes an idle session once it exceeds idle_timeout_ms, via the independent sweep', async () => {
      const { app, mcpSessions, metrics } = await buildTrackedApp(
        createConfig(false, true, { mcpSession: { idle_timeout_ms: 30, sweep_interval_ms: 20 } }),
      );

      const initRes = await initializeSession(app);
      const sessionId = initRes.headers['mcp-session-id'];
      expect(mcpSessions.size).toBe(1);

      // Real elapsed time (not fake timers, to keep the real HTTP round trip
      // above intact) comfortably past idle_timeout_ms and at least one
      // sweep_interval_ms tick.
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mcpSessions.size).toBe(0);
      expect(metrics.incCounter).toHaveBeenCalledWith(
        'bhgbrain_mcp_sessions_evicted_total', 1, { reason: 'idle' },
      );

      const afterIdleExpiry = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', MCP_ACCEPT)
        .set('Authorization', 'Bearer secret-token')
        .set('mcp-session-id', sessionId)
        .send(toolsListBody());
      expect(afterIdleExpiry.status).toBe(404);
    });

    it('activity postpones idle expiry', async () => {
      const { app, mcpSessions } = await buildTrackedApp(
        createConfig(false, true, { mcpSession: { idle_timeout_ms: 150, sweep_interval_ms: 20 } }),
      );

      const initRes = await initializeSession(app);
      const sessionId = initRes.headers['mcp-session-id'];

      // Send activity partway through the idle window...
      await new Promise(resolve => setTimeout(resolve, 80));
      const midway = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', MCP_ACCEPT)
        .set('Authorization', 'Bearer secret-token')
        .set('mcp-session-id', sessionId)
        .send(toolsListBody());
      expect(midway.status).toBe(200);

      // ...then wait past the ORIGINAL deadline (but well within a fresh one
      // counted from the activity above) — the session must still be alive.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(mcpSessions.size).toBe(1);

      const stillAlive = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', MCP_ACCEPT)
        .set('Authorization', 'Bearer secret-token')
        .set('mcp-session-id', sessionId)
        .send(toolsListBody());
      expect(stillAlive.status).toBe(200);
    });

    it('closeAll() stops the idle sweep timer', async () => {
      const { mcpSessions } = await buildTrackedApp(
        createConfig(false, true, { mcpSession: { idle_timeout_ms: 30, sweep_interval_ms: 20 } }),
      );

      await mcpSessions.closeAll();

      // No open handle/exception from a sweep continuing to fire after
      // teardown — if the timer weren't cleared this would still pass
      // functionally, so this test mainly documents the expectation and
      // guards against `closeAll` throwing.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mcpSessions.size).toBe(0);
    });

    // strengthen-verification-and-code-boundaries task 2.2: every session
    // McpSessionManager itself tears down (idle sweep, capacity eviction,
    // closeAll) must have its transport closed exactly once — a double close
    // would surface as a second `transport.close()` call on an
    // already-removed registry entry. (An explicit `DELETE /mcp` closes
    // itself through the SDK's own internal request handling rather than
    // through `McpSessionManager.evictSession`/`closeAll`, so that path is
    // verified separately below by confirming it removes the session from
    // the registry — leaving nothing there for a later `closeAll()` to
    // double-close.)
    it('closes each manager-evicted session\'s transport exactly once across idle eviction, capacity eviction, and closeAll', async () => {
      const closeSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');
      try {
        const { app, mcpSessions } = await buildApp(
          createConfig(false, true, { mcpSession: { max_sessions: 1, idle_timeout_ms: 30, sweep_interval_ms: 20 } }),
        );

        // Idle-swept session: evictSession() -> exactly one close() call.
        const idleInit = await initializeSession(app);
        expect(idleInit.status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(mcpSessions.size).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        // Capacity-evicted session (max_sessions: 1): the second initialize
        // evicts the first via the same evictSession() path -> one more
        // close() call, and only one — the surviving second session is
        // untouched.
        const first = await initializeSession(app);
        expect(first.status).toBe(200);
        const second = await initializeSession(app);
        expect(second.status).toBe(200);
        expect(closeSpy).toHaveBeenCalledTimes(2);
        expect(mcpSessions.size).toBe(1);

        // DELETE the survivor: closes itself via the SDK's own internal
        // handling (not McpSessionManager.evictSession, so it does not add
        // to closeSpy's count), but must still leave the registry empty so
        // it can never be double-closed by a later closeAll().
        const secondSessionId = second.headers['mcp-session-id'];
        await request(app)
          .delete('/mcp')
          .set('Authorization', 'Bearer secret-token')
          .set('mcp-session-id', secondSessionId);
        expect(mcpSessions.size).toBe(0);
        expect(closeSpy).toHaveBeenCalledTimes(2);

        // closeAll() on one freshly created, still-live session: exactly one
        // more close() call, proving it did not also re-close the
        // already-DELETEd session above.
        const third = await initializeSession(app);
        expect(third.status).toBe(200);
        await mcpSessions.closeAll();
        expect(closeSpy).toHaveBeenCalledTimes(3);

        // Every recorded close() call targeted a distinct transport instance
        // — the counts above already prove no session was closed twice, but
        // this additionally rules out the same instance being invoked
        // multiple times under a mock that could otherwise mask it.
        const closedInstances = new Set(closeSpy.mock.instances);
        expect(closedInstances.size).toBe(closeSpy.mock.calls.length);
      } finally {
        closeSpy.mockRestore();
      }
    });
  });
});

describe('listenAsync (align-runtime-entrypoint-contracts task 3.2)', () => {
  let servers: HttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(s => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
  });

  it('resolves with a listening server once the bind succeeds', async () => {
    const { listenAsync } = await import('./http.js');
    const app = express();

    const server = await listenAsync(app, 0, '127.0.0.1');
    servers.push(server);

    expect(server.listening).toBe(true);
  });

  it('rejects (instead of throwing an unhandled error event) when the port is already in use', async () => {
    const { listenAsync } = await import('./http.js');
    const first = await listenAsync(express(), 0, '127.0.0.1');
    servers.push(first);
    const address = first.address();
    const port = typeof address === 'object' && address ? address.port : undefined;
    expect(port).toBeDefined();

    await expect(listenAsync(express(), port!, '127.0.0.1'))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
});
