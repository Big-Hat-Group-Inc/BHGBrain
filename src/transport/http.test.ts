import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { BrainConfig } from '../config/index.js';

const handleToolMock = vi.fn();

vi.mock('../tools/index.js', () => ({
  handleTool: handleToolMock,
}));

describe('createHttpServer', () => {
  function createConfig(metricsEnabled = false, authRequired = true): BrainConfig {
    return {
      data_dir: 'test-data',
      embedding: { provider: 'openai', model: 'test-model', api_key_env: 'OPENAI_API_KEY', dimensions: 3 },
      qdrant: { mode: 'embedded', embedded_path: './qdrant', external_url: null, api_key_env: null },
      transport: {
        http: { enabled: true, host: '127.0.0.1', port: 3721, bearer_token_env: 'BHGBRAIN_TOKEN' },
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
        pre_expiry_warning_days: 7,
        compaction_deleted_threshold: 0.1,
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
        rate_limit_rpm: 100,
        max_request_size_bytes: 1048576,
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

  async function startServer(config: BrainConfig, overrides?: {
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

    const app = createHttpServer(
      config,
      ctx as never,
      resources as never,
      logger as never,
    );
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    return { baseUrl, server, resources };
  }

  async function closeServer(server: import('node:http').Server) {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }

  afterEach(async () => {
    vi.clearAllMocks();
    delete process.env.BHGBRAIN_TOKEN;
  });

  it('returns health without auth and uses 200/503 based on status', async () => {
    const healthy = await startServer(createConfig(false, true), {
      health: { check: vi.fn(async () => ({ status: 'healthy' })) },
    });
    const healthyResponse = await fetch(`${healthy.baseUrl}/health`);
    expect(healthyResponse.status).toBe(200);
    await healthyResponse.json();
    await closeServer(healthy.server);

    const unhealthy = await startServer(createConfig(false, true), {
      health: { check: vi.fn(async () => ({ status: 'unhealthy' })) },
    });
    const unhealthyResponse = await fetch(`${unhealthy.baseUrl}/health`);
    expect(unhealthyResponse.status).toBe(503);
    await unhealthyResponse.json();
    await closeServer(unhealthy.server);
  }, 15000);

  it('rejects tool calls without or with invalid auth', async () => {
    const { baseUrl, server } = await startServer(createConfig(false, true));

    const missingAuth = await fetch(`${baseUrl}/tool/remember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(missingAuth.status).toBe(401);

    const invalidAuth = await fetch(`${baseUrl}/tool/remember`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token',
      },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(invalidAuth.status).toBe(401);

    await closeServer(server);
  });

  it('calls handleTool and resources when authorized', async () => {
    handleToolMock.mockResolvedValue({ ok: true });
    const resourcesHandle = vi.fn(async () => ({ resource: true }));
    const { baseUrl, server } = await startServer(createConfig(false, true), {
      resources: { handle: resourcesHandle },
    });

    const toolResponse = await fetch(`${baseUrl}/tool/remember`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret-token',
        'x-client-id': 'client-1',
      },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(toolResponse.status).toBe(200);
    expect(await toolResponse.json()).toEqual({ ok: true });
    expect(handleToolMock).toHaveBeenCalledWith(expect.anything(), 'remember', { content: 'hello' }, 'client-1');

    const missingUri = await fetch(`${baseUrl}/resource`, {
      headers: { 'Authorization': 'Bearer secret-token' },
    });
    expect(missingUri.status).toBe(400);

    const resourceResponse = await fetch(`${baseUrl}/resource?uri=memory://list`, {
      headers: { 'Authorization': 'Bearer secret-token' },
    });
    expect(resourceResponse.status).toBe(200);
    expect(await resourceResponse.json()).toEqual({ resource: true });
    expect(resourcesHandle).toHaveBeenCalledWith('memory://list');

    await closeServer(server);
  });

  it('serves metrics only when enabled', async () => {
    const disabled = await startServer(createConfig(false, true));
    const disabledResponse = await fetch(`${disabled.baseUrl}/metrics`, {
      headers: { 'Authorization': 'Bearer secret-token' },
    });
    expect(disabledResponse.status).toBe(404);
    await disabledResponse.text();
    await closeServer(disabled.server);

    const enabled = await startServer(createConfig(true, true), {
      metrics: {
        getMetrics: vi.fn(() => [
          { name: 'bhgbrain_tool_handler_ms_p95', value: 12 },
          { name: 'search_total_ms_p95', value: 5 },
        ]),
      },
    });
    const enabledResponse = await fetch(`${enabled.baseUrl}/metrics`, {
      headers: { 'Authorization': 'Bearer secret-token' },
    });
    expect(enabledResponse.status).toBe(200);
    expect(await enabledResponse.text()).toContain('bhgbrain_tool_handler_ms_p95 12');
    await closeServer(enabled.server);
  });
});
