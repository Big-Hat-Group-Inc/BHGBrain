import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  executeLlmRequest,
  executeSingleLlmRequest,
  extractChatMessageContent,
  resolveApiKey,
  requireApiKey,
  resolveLlmBaseUrl,
  resolveLlmRetryConfig,
  parseRetryAfterMs,
  computeBackoffDelayMs,
  LlmRequestError,
  DEFAULT_LLM_RETRY,
  type LlmRequestOptions,
} from './client.js';
import type { CircuitBreaker } from '../resilience/index.js';

describe('resolveApiKey / requireApiKey', () => {
  afterEach(() => {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('resolves the primary env var when set', () => {
    process.env.TEST_PRIMARY_KEY = 'primary';
    expect(resolveApiKey('TEST_PRIMARY_KEY', { fallbackToOpenAI: true })).toBe('primary');
  });

  it('falls back to OPENAI_API_KEY when fallbackToOpenAI is true and primary is unset', () => {
    process.env.OPENAI_API_KEY = 'fallback';
    expect(resolveApiKey('TEST_PRIMARY_KEY', { fallbackToOpenAI: true })).toBe('fallback');
  });

  it('does not fall back when fallbackToOpenAI is false', () => {
    process.env.OPENAI_API_KEY = 'fallback';
    expect(resolveApiKey('TEST_PRIMARY_KEY', { fallbackToOpenAI: false })).toBeUndefined();
  });

  it('requireApiKey throws the documented message when nothing resolves', () => {
    expect(() => requireApiKey('TEST_PRIMARY_KEY')).toThrow('Missing environment variable: TEST_PRIMARY_KEY');
  });
});

describe('resolveLlmBaseUrl / resolveLlmRetryConfig', () => {
  it('defaults to the OpenAI base URL when unset', () => {
    expect(resolveLlmBaseUrl(undefined)).toBe('https://api.openai.com/v1');
  });

  it('uses a custom base URL when provided', () => {
    expect(resolveLlmBaseUrl('https://gateway.example.test/v1')).toBe('https://gateway.example.test/v1');
  });

  it('falls back to DEFAULT_LLM_RETRY when no config retry is supplied', () => {
    expect(resolveLlmRetryConfig(undefined)).toEqual(DEFAULT_LLM_RETRY);
  });

  it('maps a configured retry object to the internal shape', () => {
    expect(resolveLlmRetryConfig({ max_attempts: 5, backoff_ms: 10, max_backoff_ms: 100 })).toEqual({
      maxAttempts: 5,
      backoffMs: 10,
      maxBackoffMs: 100,
    });
  });
});

describe('parseRetryAfterMs', () => {
  it('parses a numeric seconds value', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
  });

  it('returns null for a missing header', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  it('returns null for a negative seconds value', () => {
    expect(parseRetryAfterMs('-5')).toBeNull();
  });

  it('returns null for an unparseable value', () => {
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });

  it('parses an HTTP-date into a non-negative delta', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms).toBeGreaterThan(0);
  });
});

describe('computeBackoffDelayMs', () => {
  it('caps the exponential envelope at maxBackoffMs', () => {
    const retry = { maxAttempts: 10, backoffMs: 1000, maxBackoffMs: 1500 };
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = computeBackoffDelayMs(attempt, retry);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1500);
    }
  });

  it('raises the floor to at least a valid Retry-After, bounded by the cap', () => {
    const retry = { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 5000 };
    const delay = computeBackoffDelayMs(1, retry, 3000);
    expect(delay).toBeGreaterThanOrEqual(3000);
    expect(delay).toBeLessThanOrEqual(5000);
  });
});

describe('extractChatMessageContent', () => {
  it('extracts the assistant message content', async () => {
    const response = new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 });
    await expect(extractChatMessageContent(response, 'Test')).resolves.toBe('hello');
  });

  it('throws when the message content is missing', async () => {
    const response = new Response(JSON.stringify({ choices: [] }), { status: 200 });
    await expect(extractChatMessageContent(response, 'Test')).rejects.toThrow('Test API response had no message content');
  });
});

describe('executeSingleLlmRequest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the given url/headers/body and returns the raw response', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await executeSingleLlmRequest({
      url: 'https://example.test/x',
      headers: { Authorization: 'Bearer x' },
      body: { a: 1 },
      timeoutMs: 1000,
    });

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.test/x');
    expect(JSON.parse(init.body as string)).toEqual({ a: 1 });
  });

  it('aborts once timeoutMs elapses', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })));

    await expect(executeSingleLlmRequest({
      url: 'https://example.test/x', headers: {}, body: {}, timeoutMs: 5,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('executeLlmRequest', () => {
  afterEach(() => vi.unstubAllGlobals());

  function baseOptions<T>(overrides: Partial<LlmRequestOptions<T>> & { parseResponse: LlmRequestOptions<T>['parseResponse'] }): LlmRequestOptions<T> {
    return {
      url: 'https://example.test/chat',
      headers: {},
      body: {},
      timeoutMs: 1000,
      retry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 10 },
      useBreaker: false,
      errorPrefix: 'Test',
      ...overrides,
    };
  }

  it('resolves with the validator result on a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const result = await executeLlmRequest(baseOptions({ parseResponse: async r => r.status }));
    expect(result).toBe(200);
  });

  it('classifies 429 as retryable rate_limited and retries up to maxAttempts', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeLlmRequest(baseOptions({ parseResponse: async () => 'unused' })))
      .rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('classifies 401 as non-retryable client_error and does not retry', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeLlmRequest(baseOptions({ parseResponse: async () => 'unused' })))
      .rejects.toMatchObject({ code: 'client_error', retryable: false, status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies 408 as retryable timeout', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 408 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeLlmRequest(baseOptions({
      parseResponse: async () => 'unused',
      retry: { maxAttempts: 2, backoffMs: 1, maxBackoffMs: 10 },
    }))).rejects.toMatchObject({ code: 'timeout', retryable: true, status: 408 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies 500 as retryable server_error', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeLlmRequest(baseOptions({
      parseResponse: async () => 'unused',
      retry: { maxAttempts: 2, backoffMs: 1, maxBackoffMs: 10 },
    }))).rejects.toMatchObject({ code: 'server_error', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers after a transient failure', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response('', { status: 503 });
      return new Response('recovered', { status: 200 });
    }));

    const result = await executeLlmRequest(baseOptions({
      parseResponse: async r => r.text(),
      retry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 10 },
    }));
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('a validator failure is non-retryable and preserves the original message', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeLlmRequest(baseOptions({
      parseResponse: async () => { throw new Error('schema validation failed'); },
    }))).rejects.toMatchObject({ code: 'invalid_response', retryable: false, message: 'schema validation failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a deadline that expires mid-body-read (post-header stall) aborts, is retryable, and trips the breaker once', async () => {
    // Response headers resolve immediately (response.ok), but parseResponse
    // (the "body read") hangs until the abort signal fires — this is exactly
    // the "provider stalls after sending headers" scenario the deadline must
    // cover per spec (Decision #1: the abort timer clears only in `finally`
    // after parseResponse settles, not right after fetch() resolves).
    let bodyReadSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      bodyReadSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response('ok', { status: 200 }));
    }));

    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;

    const hangingParseResponse = () => new Promise<never>((_resolve, reject) => {
      bodyReadSignal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

    await expect(executeLlmRequest(baseOptions({
      parseResponse: hangingParseResponse,
      timeoutMs: 5,
      retry: { maxAttempts: 1, backoffMs: 1, maxBackoffMs: 10 },
      useBreaker: true,
      breaker,
    }))).rejects.toMatchObject({ code: 'timeout', retryable: true });

    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });

  it('wraps the whole retry loop in a single breaker.execute call', async () => {
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));

    await expect(executeLlmRequest(baseOptions({
      parseResponse: async () => 'unused',
      retry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 10 },
      useBreaker: true,
      breaker,
    }))).rejects.toThrow();

    expect(breaker.execute).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the breaker when useBreaker is false', async () => {
    const breaker = {
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    } as unknown as CircuitBreaker;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await executeLlmRequest(baseOptions({ parseResponse: async () => 'x', useBreaker: false, breaker }));
    expect(breaker.execute).not.toHaveBeenCalled();
  });

  it('honors a valid Retry-After header as a floor on the retry delay', async () => {
    const fetchMock = vi.fn(async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': '1' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const start = Date.now();
    await expect(executeLlmRequest(baseOptions({
      parseResponse: async () => 'unused',
      retry: { maxAttempts: 2, backoffMs: 1, maxBackoffMs: 5000 },
    }))).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(1000);
  });

  it('rejects a network error (non-HTTP failure) as retryable', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeLlmRequest(baseOptions({
      parseResponse: async () => 'unused',
      retry: { maxAttempts: 2, backoffMs: 1, maxBackoffMs: 10 },
    }))).rejects.toMatchObject({ code: 'network_error', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('LlmRequestError', () => {
  it('carries code, retryable, status, and retryAfterMs', () => {
    const err = new LlmRequestError('boom', 'rate_limited', true, 429, 2000);
    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.name).toBe('LlmRequestError');
  });
});
