import type { CircuitBreaker } from '../resilience/index.js';

/**
 * Shared OpenAI-compatible chat/embedding request boundary
 * (unify-llm-client-boundaries). Before this module, embedding had its own
 * timeout/retry/classification helper (`src/embedding/request.ts`, now
 * removed) while extraction, reranking, summarization, query expansion,
 * entailment, and distillation each built a bare `fetch` + `AbortController`
 * by hand — with inconsistent timeouts, no retry, no status classification,
 * and (critically) an abort deadline that stopped covering the response once
 * headers arrived, so a provider that stalled mid-body never tripped a
 * breaker. Every one of those call sites now goes through
 * `executeLlmRequest` below, which owns the complete attempt lifecycle: the
 * abort timer stays armed through `fetch`, body consumption, and the
 * caller's own response validator, and only clears in `finally` once all of
 * that has settled — so a post-header stall aborts and is recorded as a
 * breaker failure, not a silent breaker success. See design.md Decision #1.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Sane fallback for callers constructed from a hand-rolled (non-Zod-parsed)
 * config, e.g. unit tests that build a `BrainConfig`-shaped object without a
 * `llm` section. Real configs always populate `config.llm.retry` via the
 * schema's `prefault({})`, with these exact numbers. */
export const DEFAULT_LLM_RETRY: LlmRetryConfig = {
  maxAttempts: 3,
  backoffMs: 200,
  maxBackoffMs: 2000,
};

export type LlmErrorCode =
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'timeout'
  | 'network_error'
  | 'invalid_response';

/**
 * A classified, retryability-preserving failure from `executeLlmRequest`.
 * Every feature adapter can rely on `.retryable` and `.code` reflecting the
 * *original* cause (HTTP status, abort, network error, or the caller's own
 * response validator) rather than a generic re-wrapped error — see design.md
 * Decision #6 ("Preserve original classified errors at feature boundaries").
 */
export class LlmRequestError extends Error {
  constructor(
    message: string,
    public readonly code: LlmErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmRequestError';
  }
}

export interface LlmRetryConfig {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface LlmRequestOptions<T> {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  retry: LlmRetryConfig;
  breaker?: CircuitBreaker;
  useBreaker: boolean;
  // Human-readable feature/provider name used to attribute classified error
  // messages, e.g. "Rerank", "Azure embeddings", "Entailment check".
  errorPrefix: string;
  /**
   * Parses and validates a successful (2xx) response's body, returning the
   * feature-specific typed result. Runs inside the same deadline and (when
   * `useBreaker`) the same breaker call as the rest of the attempt — a
   * validator that throws (including because the deadline aborted mid-read)
   * counts as a failed attempt, not a successful one.
   */
  parseResponse: (response: Response) => Promise<T>;
}

export interface LlmSingleRequestOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}

/**
 * Resolves a feature's API key: the feature-specific env var name, optionally
 * falling back to `OPENAI_API_KEY` when that documented fallback applies
 * (extraction, query expansion, summarization, entailment, distillation) —
 * never for reranking, which is deliberately unfallback'd (README.md
 * "Environment Variables": "no fallback to OPENAI_API_KEY"). See design.md
 * Decision #3 and task 1.2.
 */
export function resolveApiKey(envVarName: string, options?: { fallbackToOpenAI?: boolean }): string | undefined {
  const primary = process.env[envVarName];
  if (primary) return primary;
  return options?.fallbackToOpenAI ? process.env.OPENAI_API_KEY : undefined;
}

/** Like `resolveApiKey`, but throws the documented `Missing environment
 * variable: <name>` error (matching every provider constructor's existing
 * message) instead of returning `undefined`. */
export function requireApiKey(envVarName: string, options?: { fallbackToOpenAI?: boolean }): string {
  const key = resolveApiKey(envVarName, options);
  if (!key) {
    throw new Error(`Missing environment variable: ${envVarName}`);
  }
  return key;
}

export function resolveLlmBaseUrl(baseUrl: string | undefined): string {
  return baseUrl && baseUrl.length > 0 ? baseUrl : DEFAULT_BASE_URL;
}

export function resolveLlmRetryConfig(
  configRetry: { max_attempts: number; backoff_ms: number; max_backoff_ms: number } | undefined,
): LlmRetryConfig {
  return configRetry
    ? { maxAttempts: configRetry.max_attempts, backoffMs: configRetry.backoff_ms, maxBackoffMs: configRetry.max_backoff_ms }
    : DEFAULT_LLM_RETRY;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Parses a `Retry-After` header (seconds, or an HTTP-date) into milliseconds.
 * Returns `null` for a missing/invalid/unparseable header rather than
 * throwing — an untrusted provider header must never crash the request path.
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : null;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

/**
 * Classifies a non-2xx response into a retryable/non-retryable
 * `LlmRequestError`, reading (and bounding) the body for the error message.
 * Retry policy (design.md Decision #4): 429 and 408 are always retryable;
 * 500/502/503/504 ("selected 5xx" — transient/overload signals) are
 * retryable; every other 5xx (e.g. 501 Not Implemented, 505) and every other
 * 4xx (400/401/403/404/422/...) are permanent — retrying cannot fix bad
 * credentials, a bad payload, or an endpoint that fundamentally doesn't
 * support the request.
 */
async function classifyHttpError(response: Response, errorPrefix: string): Promise<LlmRequestError> {
  const status = response.status;
  const bodyText = await response.text().catch(() => '');
  const message = `${errorPrefix} API error ${status}: ${bodyText.slice(0, 200)}`;

  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    return new LlmRequestError(message, 'rate_limited', true, status, retryAfterMs ?? undefined);
  }
  if (status === 408) {
    return new LlmRequestError(message, 'timeout', true, status);
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    return new LlmRequestError(message, 'server_error', true, status, retryAfterMs ?? undefined);
  }
  if (status >= 500 && status < 600) {
    return new LlmRequestError(message, 'server_error', false, status);
  }
  return new LlmRequestError(message, 'client_error', false, status);
}

/**
 * A single bounded attempt: fetch with an `AbortController` timeout that
 * stays armed through `parseResponse` (body read + validation), no retry, no
 * classification beyond wrapping into `LlmRequestError`, no breaker. Thrown
 * errors are always `LlmRequestError` so `executeWithRetry` can inspect
 * `.retryable` uniformly.
 */
async function attemptOnce<T>(options: LlmRequestOptions<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(options.url, {
        method: 'POST',
        headers: options.headers,
        body: JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new LlmRequestError(`${options.errorPrefix} request timed out after ${options.timeoutMs}ms`, 'timeout', true);
      }
      throw new LlmRequestError(`${options.errorPrefix} request failed: ${errorMessage(err)}`, 'network_error', true);
    }

    if (!response.ok) {
      throw await classifyHttpError(response, options.errorPrefix);
    }

    try {
      return await options.parseResponse(response);
    } catch (err) {
      if (err instanceof LlmRequestError) throw err;
      if (isAbortError(err)) {
        throw new LlmRequestError(
          `${options.errorPrefix} request timed out after ${options.timeoutMs}ms while reading the response`,
          'timeout',
          true,
        );
      }
      // A validator failure (malformed JSON, schema mismatch, wrong
      // cardinality) is a bad provider response, not a transient condition —
      // retrying the exact same request would return the exact same
      // malformed body. Non-retryable by design (spec "Provider responses
      // SHALL be validated before use").
      throw new LlmRequestError(errorMessage(err), 'invalid_response', false);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Capped full-jitter backoff (design.md Decision #4 / spec "Retries SHALL
 * honor provider guidance and avoid synchronization"): the exponential
 * envelope `backoffMs * 2^(attempt-1)`, capped at `maxBackoffMs`, then a
 * uniform random delay in `[0, cap]` so concurrent callers don't retry in
 * lockstep. A valid `Retry-After` raises the floor to at least that delay
 * (still capped) rather than being ignored by the jitter.
 */
export function computeBackoffDelayMs(attempt: number, retry: LlmRetryConfig, retryAfterMs?: number): number {
  const exponential = retry.backoffMs * Math.pow(2, attempt - 1);
  const cap = Math.min(retry.maxBackoffMs, exponential);
  const jittered = Math.random() * cap;
  if (retryAfterMs !== undefined && retryAfterMs !== null) {
    const boundedFloor = Math.min(retryAfterMs, retry.maxBackoffMs);
    return Math.max(jittered, boundedFloor);
  }
  return jittered;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeWithRetry<T>(options: LlmRequestOptions<T>): Promise<T> {
  const run = async (attempt: number): Promise<T> => {
    try {
      return await attemptOnce(options);
    } catch (err) {
      const classified = err instanceof LlmRequestError
        ? err
        : new LlmRequestError(`${options.errorPrefix} request failed: ${errorMessage(err)}`, 'network_error', true);

      if (!classified.retryable || attempt >= options.retry.maxAttempts) {
        throw classified;
      }

      const delay = computeBackoffDelayMs(attempt, options.retry, classified.retryAfterMs);
      await sleep(delay);
      return run(attempt + 1);
    }
  };

  return run(1);
}

/**
 * The complete request-attempt executor (task 1.4): bounds every attempt
 * with a deadline that covers response validation, classifies HTTP/network/
 * abort failures, retries only classified-transient ones with capped
 * jittered backoff, and — when `useBreaker` and a breaker are supplied —
 * wraps the *whole* retry loop in one `breaker.execute` call, so one logical
 * operation records at most one breaker outcome regardless of how many
 * internal attempts it took (design.md Decision #1).
 */
export async function executeLlmRequest<T>(options: LlmRequestOptions<T>): Promise<T> {
  const op = () => executeWithRetry(options);
  if (options.useBreaker && options.breaker) {
    return options.breaker.execute(op);
  }
  return op();
}

/**
 * A single bounded attempt with no retry, no classification, no breaker —
 * used only for single-shot health-check probes (README.md-documented
 * "single-shot" probe contract), mirroring the old
 * `executeSingleEmbeddingRequest`.
 */
export async function executeSingleLlmRequest(options: LlmSingleRequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  return fetch(options.url, {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify(options.body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
}

/**
 * Shared chat-completions response-body step used by every migrated chat
 * feature (extraction, rerank, summarization, query expansion, entailment,
 * distillation): parses the JSON envelope and extracts the assistant
 * message's raw string content. Each feature's own JSON.parse + schema
 * validation of *that* string happens outside this helper, unchanged from
 * before this migration — this only removes the five-times-duplicated
 * envelope-unwrapping step.
 */
export async function extractChatMessageContent(response: Response, errorPrefix: string): Promise<string> {
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const message = data.choices?.[0]?.message?.content;
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error(`${errorPrefix} API response had no message content`);
  }
  return message;
}
