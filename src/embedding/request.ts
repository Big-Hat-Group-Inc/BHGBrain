import type { CircuitBreaker } from '../resilience/index.js';
import { BrainError, embeddingUnavailable, rateLimited } from '../errors/index.js';

/**
 * Shared timeout/retry/classification machinery for embedding-provider HTTP
 * requests (cut-embedding-and-qdrant-round-trips). Extracted from the Azure
 * Foundry provider's `executeSingleRequest`/`requestWithRetry`/
 * `isRetryableError` (the only provider that previously implemented the
 * documented `request_timeout_ms`/`retry.*` contract) so both `openai` and
 * `azure-foundry` apply identical bounding, retry, and error classification.
 * Providers differ only in URL, headers, and request body — all supplied by
 * the caller — plus `errorPrefix`, which keeps classified error messages
 * provider-attributable (e.g. "Azure embeddings rate limited" vs "OpenAI
 * embeddings rate limited") without duplicating the classification logic.
 */

export interface RetryConfig {
  max_attempts: number;
  backoff_ms: number;
}

export interface SingleEmbeddingRequestOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}

export interface EmbeddingRequestWithRetryOptions extends SingleEmbeddingRequestOptions {
  retry: RetryConfig;
  breaker?: CircuitBreaker;
  useBreaker: boolean;
  // Human-readable provider name used to attribute classified error
  // messages, e.g. "Azure" or "OpenAI".
  errorPrefix: string;
}

/**
 * A single bounded attempt: fetch with an `AbortController` timeout, no
 * retry, no classification, no breaker. This is what health checks use
 * directly (README.md-documented "single-shot" probe contract) — the
 * retry/classification loop below is never engaged for a health probe.
 */
export async function executeSingleEmbeddingRequest(options: SingleEmbeddingRequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  return fetch(options.url, {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify(options.body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
}

function isRetryableEmbeddingError(err: unknown): boolean {
  if (err instanceof BrainError) {
    return err.retryable;
  }
  if (err instanceof Error) {
    return err.name === 'AbortError' || err instanceof TypeError || /fetch|network/i.test(err.message);
  }
  return false;
}

/**
 * Bounds every attempt with `executeSingleEmbeddingRequest`, classifies the
 * response status (429 -> rateLimited, 5xx -> retryable embeddingUnavailable,
 * 400/401/403/404 and other 4xx -> non-retryable BrainError), and retries
 * retryable failures with exponential backoff (`backoff_ms * 2^(attempt-1)`)
 * up to `retry.max_attempts`. The whole retry loop runs inside a single
 * `breaker.execute` call (when `useBreaker` and a breaker are provided) so
 * one logical operation records at most one breaker failure regardless of
 * how many internal attempts it took.
 */
export async function requestEmbeddingsWithRetry(options: EmbeddingRequestWithRetryOptions): Promise<Response> {
  const { retry, errorPrefix } = options;

  const executeRequest = async (attempt: number): Promise<Response> => {
    try {
      const response = await executeSingleEmbeddingRequest(options);
      if (response.ok) {
        return response;
      }

      const status = response.status;
      if (status === 429) {
        throw rateLimited(`${errorPrefix} embeddings rate limited`);
      }

      if (status >= 500 && status < 600) {
        throw embeddingUnavailable(`${errorPrefix} embedding provider error ${status}`);
      }

      // Non-retryable errors
      if ([400, 401, 403, 404].includes(status)) {
        throw new BrainError('EMBEDDING_UNAVAILABLE', `${errorPrefix} embeddings request rejected (HTTP ${status})`, false);
      }

      // Other 4xx errors are not retryable
      if (status >= 400 && status < 500) {
        throw new BrainError('EMBEDDING_UNAVAILABLE', `${errorPrefix} embeddings client error ${status}`, false);
      }

      // Should not happen
      throw embeddingUnavailable(`${errorPrefix} embeddings unexpected status ${status}`);
    } catch (err) {
      const retryable = isRetryableEmbeddingError(err);
      if (!retryable || attempt >= retry.max_attempts) {
        throw err;
      }

      const delay = retry.backoff_ms * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
      return executeRequest(attempt + 1);
    }
  };

  if (options.useBreaker && options.breaker) {
    return options.breaker.execute(() => executeRequest(1));
  }

  return executeRequest(1);
}
