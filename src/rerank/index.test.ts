import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OpenAiRerankProvider,
  DegradedRerankProvider,
  createRerankProvider,
  warnIfRerankDegraded,
  resolveRerankBootstrap,
} from './index.js';
import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import { CircuitBreaker } from '../resilience/index.js';

function createConfig(overrides: Partial<BrainConfig['search']['rerank']> = {}): BrainConfig {
  return {
    search: {
      rerank: {
        enabled: false,
        provider: 'openai',
        candidate_pool: 20,
        model: 'gpt-4o-mini',
        model_env: 'BHGBRAIN_RERANK_API_KEY',
        timeout_ms: 3000,
        ...overrides,
      },
    },
  } as unknown as BrainConfig;
}

function chatResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function withScores(scores: Array<{ id: string; score: number }>): unknown {
  return { choices: [{ message: { content: JSON.stringify({ scores }) } }] };
}

const CANDIDATES = [
  { id: 'a', text: 'first candidate text' },
  { id: 'b', text: 'second candidate text' },
];

describe('OpenAiRerankProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BHGBRAIN_RERANK_API_KEY;
  });

  it('throws a missing-env-var error when the configured key is unset', () => {
    delete process.env.BHGBRAIN_RERANK_API_KEY;
    expect(() => new OpenAiRerankProvider(createConfig())).toThrow(
      'Missing environment variable: BHGBRAIN_RERANK_API_KEY',
    );
  });

  it('sends the expected request shape', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => chatResponse(withScores([{ id: 'a', score: 0.9 }])));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiRerankProvider(createConfig());
    await provider.score('my query', CANDIDATES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(init.body as string) as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format).toEqual({ type: 'json_object' });
    const userMessage = JSON.parse(body.messages[1]!.content) as { query: string; candidates: unknown };
    expect(userMessage.query).toBe('my query');
    expect(userMessage.candidates).toEqual(CANDIDATES);
  });

  it('parses a valid response into the expected Map', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withScores([
      { id: 'a', score: 0.8 },
      { id: 'b', score: 0.2 },
    ]))));
    const provider = new OpenAiRerankProvider(createConfig());
    const result = await provider.score('q', CANDIDATES);
    expect(result).toEqual(new Map([['a', 0.8], ['b', 0.2]]));
  });

  it('clamps out-of-range scores to [0, 1]', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withScores([
      { id: 'a', score: 1.5 },
      { id: 'b', score: -0.3 },
    ]))));
    const provider = new OpenAiRerankProvider(createConfig());
    const result = await provider.score('q', CANDIDATES);
    expect(result).toEqual(new Map([['a', 1], ['b', 0]]));
  });

  it('drops ids not present in the requested candidate set', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withScores([
      { id: 'a', score: 0.5 },
      { id: 'not-a-candidate', score: 0.9 },
    ]))));
    const provider = new OpenAiRerankProvider(createConfig());
    const result = await provider.score('q', CANDIDATES);
    expect(result).toEqual(new Map([['a', 0.5]]));
  });

  it('rejects on a non-2xx response', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse({ error: 'nope' }, 500)));
    const provider = new OpenAiRerankProvider(createConfig());
    await expect(provider.score('q', CANDIDATES)).rejects.toThrow(/Rerank API error 500/);
  });

  it('rejects on timeout, aborting at timeout_ms', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal;
      signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })));
    const provider = new OpenAiRerankProvider(createConfig({ timeout_ms: 5 }));
    await expect(provider.score('q', CANDIDATES)).rejects.toThrow();
  });

  it('rejects on malformed JSON in the message content', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    // The outer chat-completions envelope is valid JSON; it's the assistant
    // message's `content` string (the actual rerank payload) that is not.
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse({ choices: [{ message: { content: 'not json' } }] })));
    const provider = new OpenAiRerankProvider(createConfig());
    await expect(provider.score('q', CANDIDATES)).rejects.toThrow('Rerank API response was not valid JSON');
  });

  it('rejects when the response envelope itself is not valid JSON', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    const provider = new OpenAiRerankProvider(createConfig());
    await expect(provider.score('q', CANDIDATES)).rejects.toThrow();
  });

  it('rejects on a response that fails schema validation', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse({ choices: [{ message: { content: JSON.stringify({ unexpected: true }) } }] })));
    const provider = new OpenAiRerankProvider(createConfig());
    await expect(provider.score('q', CANDIDATES)).rejects.toThrow('Rerank API response failed schema validation');
  });

  it('records the search_rerank_ms histogram', async () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(withScores([{ id: 'a', score: 0.5 }]))));
    const metrics = { recordHistogram: vi.fn(), incCounter: vi.fn() } as unknown as MetricsCollector;
    const provider = new OpenAiRerankProvider(createConfig(), undefined, metrics);
    await provider.score('q', CANDIDATES);
    expect(metrics.recordHistogram).toHaveBeenCalledWith('search_rerank_ms', expect.any(Number));
  });
});

describe('DegradedRerankProvider', () => {
  it('always rejects score()', async () => {
    const provider = new DegradedRerankProvider(createConfig());
    await expect(provider.score('q', CANDIDATES)).rejects.toThrow(
      'Rerank provider is unavailable: missing API credentials',
    );
  });
});

describe('createRerankProvider', () => {
  afterEach(() => {
    delete process.env.BHGBRAIN_RERANK_API_KEY;
  });

  it('returns a live OpenAiRerankProvider when the key resolves', () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    const provider = createRerankProvider(createConfig());
    expect(provider).toBeInstanceOf(OpenAiRerankProvider);
  });

  it('falls back to DegradedRerankProvider when the key is missing', () => {
    delete process.env.BHGBRAIN_RERANK_API_KEY;
    const provider = createRerankProvider(createConfig());
    expect(provider).toBeInstanceOf(DegradedRerankProvider);
  });
});

describe('warnIfRerankDegraded', () => {
  it('warns when enabled but degraded', () => {
    const config = createConfig({ enabled: true });
    const provider = new DegradedRerankProvider(config);
    const logger = { warn: vi.fn() };
    warnIfRerankDegraded(provider, config, logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'rerank_degraded_startup' }));
  });

  it('does not warn when the provider is live', () => {
    const config = createConfig({ enabled: true });
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    const provider = new OpenAiRerankProvider(config);
    const logger = { warn: vi.fn() };
    warnIfRerankDegraded(provider, config, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    delete process.env.BHGBRAIN_RERANK_API_KEY;
  });

  it('does not warn when disabled', () => {
    const config = createConfig({ enabled: false });
    const provider = new DegradedRerankProvider(config);
    const logger = { warn: vi.fn() };
    warnIfRerankDegraded(provider, config, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// add-opt-in-rerank-stage task 5.6: `src/index.ts`'s bootstrap wiring is
// extracted into `resolveRerankBootstrap` specifically so it can be unit
// tested without instantiating the rest of `main()`'s dependency graph.
describe('resolveRerankBootstrap', () => {
  afterEach(() => {
    delete process.env.BHGBRAIN_RERANK_API_KEY;
  });

  function breaker(): CircuitBreaker {
    return new CircuitBreaker({ failureThreshold: 5, openWindowMs: 30000, halfOpenProbeCount: 1 });
  }

  it('does not construct a provider or surface a health breaker when disabled', () => {
    const config = createConfig({ enabled: false });
    const logger = { warn: vi.fn() };
    const result = resolveRerankBootstrap(config, { breaker: breaker(), logger });
    expect(result.rerank).toBeUndefined();
    expect(result.healthBreaker).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('constructs a live provider and surfaces its breaker when enabled with valid credentials', () => {
    process.env.BHGBRAIN_RERANK_API_KEY = 'test-key';
    const config = createConfig({ enabled: true });
    const logger = { warn: vi.fn() };
    const rerankBreaker = breaker();
    const result = resolveRerankBootstrap(config, { breaker: rerankBreaker, logger });
    expect(result.rerank).toBeInstanceOf(OpenAiRerankProvider);
    expect(result.healthBreaker).toBe(rerankBreaker);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to the degraded provider and does NOT surface a health breaker when credentials are missing', () => {
    delete process.env.BHGBRAIN_RERANK_API_KEY;
    const config = createConfig({ enabled: true });
    const logger = { warn: vi.fn() };
    const result = resolveRerankBootstrap(config, { breaker: breaker(), logger });
    expect(result.rerank).toBeInstanceOf(DegradedRerankProvider);
    expect(result.healthBreaker).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'rerank_degraded_startup' }));
  });
});
