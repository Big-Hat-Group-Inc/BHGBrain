import { describe, it, expect, vi, afterEach } from 'vitest';
import { executeSingleEmbeddingRequest, requestEmbeddingsWithRetry } from './request.js';
import type { CircuitBreaker } from '../resilience/index.js';

// Direct coverage of the shared timeout/retry/classification helper
// (cut-embedding-and-qdrant-round-trips), independent of either embedding
// provider — both `OpenAIEmbeddingProvider` and `AzureFoundryEmbeddingProvider`
// delegate to this module, so its contract is verified once here rather than
// duplicated per provider.
describe('embedding request helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('executeSingleEmbeddingRequest', () => {
    it('sends the given url/headers/body and returns the raw response', async () => {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const response = await executeSingleEmbeddingRequest({
        url: 'https://example.test/embeddings',
        headers: { Authorization: 'Bearer x' },
        body: { model: 'm', input: ['a'] },
        timeoutMs: 1000,
      });

      expect(response.status).toBe(200);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://example.test/embeddings');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ Authorization: 'Bearer x' });
      expect(JSON.parse(init.body as string)).toEqual({ model: 'm', input: ['a'] });
    });

    it('aborts the request once timeoutMs elapses', async () => {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(executeSingleEmbeddingRequest({
        url: 'https://example.test/embeddings',
        headers: {},
        body: {},
        timeoutMs: 5,
      })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('requestEmbeddingsWithRetry', () => {
    function baseOptions(overrides: Partial<Parameters<typeof requestEmbeddingsWithRetry>[0]> = {}) {
      return {
        url: 'https://example.test/embeddings',
        headers: {},
        body: {},
        timeoutMs: 1000,
        retry: { max_attempts: 3, backoff_ms: 1 },
        useBreaker: false,
        errorPrefix: 'Test',
        ...overrides,
      };
    }

    it('returns the response as-is on a 2xx', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
      const response = await requestEmbeddingsWithRetry(baseOptions());
      expect(response.status).toBe(200);
    });

    it('classifies 429 as rateLimited and retries up to max_attempts', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 429 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(requestEmbeddingsWithRetry(baseOptions())).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        message: 'Test embeddings rate limited',
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('classifies 5xx as retryable embeddingUnavailable', async () => {
      const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(requestEmbeddingsWithRetry(baseOptions({ retry: { max_attempts: 2, backoff_ms: 1 } }))).rejects.toMatchObject({
        code: 'EMBEDDING_UNAVAILABLE',
        message: 'Test embedding provider error 500',
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('classifies 400/401/403/404 as non-retryable and fails on the first attempt', async () => {
      for (const status of [400, 401, 403, 404]) {
        const fetchMock = vi.fn(async () => new Response('', { status }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(requestEmbeddingsWithRetry(baseOptions())).rejects.toMatchObject({
          code: 'EMBEDDING_UNAVAILABLE',
          message: `Test embeddings request rejected (HTTP ${status})`,
          retryable: false,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
      }
    });

    it('retries a transient failure and succeeds once the underlying call recovers', async () => {
      let calls = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response('', { status: 502 });
        return new Response('recovered', { status: 200 });
      }));

      const response = await requestEmbeddingsWithRetry(baseOptions({ retry: { max_attempts: 3, backoff_ms: 1 } }));
      expect(await response.text()).toBe('recovered');
      expect(calls).toBe(2);
    });

    it('wraps the whole retry loop in a single breaker.execute call', async () => {
      const breaker = {
        execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
      } as unknown as CircuitBreaker;
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));

      await expect(requestEmbeddingsWithRetry(baseOptions({
        retry: { max_attempts: 3, backoff_ms: 1 },
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

      await requestEmbeddingsWithRetry(baseOptions({ useBreaker: false, breaker }));
      expect(breaker.execute).not.toHaveBeenCalled();
    });
  });
});
