import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { BrainError, embeddingUnavailable, rateLimited } from '../errors/index.js';
import { AzureFoundryEmbeddingProvider } from './azure-foundry.js';
import {
  executeLlmRequest,
  executeSingleLlmRequest,
  requireApiKey,
  resolveLlmBaseUrl,
  LlmRequestError,
  type LlmRetryConfig,
} from '../llm/client.js';

function isMissingCredentialError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Missing environment variable: ');
}

/**
 * Splits `items` into chunks of at most `chunkSize`, preserving order —
 * shared by both embedding providers so `max_batch_inputs` is honored
 * identically regardless of provider (unify-llm-client-boundaries task 2.5;
 * previously only the Azure provider chunked at all, OpenAI sent every text
 * in one request regardless of `max_batch_inputs`).
 */
export function chunkInputs<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Parses an embeddings-endpoint response body and validates it before any
 * vector is trusted: the returned array must have exactly one entry per
 * requested input (never fewer — spec "Embedding gateway returns a short
 * result array" — and never more), and every vector must have the
 * configured dimension count. Reassembles results in input order via each
 * entry's `index`, independent of whatever order the provider returned them
 * in. Throws a plain `Error` on any violation — the shared request
 * executor's `parseResponse` contract wraps that as a non-retryable
 * `invalid_response` failure (retrying an already-malformed response cannot
 * fix it), and both embedding providers translate it into a classified
 * `EMBEDDING_UNAVAILABLE` `BrainError` (see `classifyEmbeddingError`).
 */
export async function parseAndValidateEmbeddingsResponse(
  response: Response,
  expectedCount: number,
  expectedDimensions: number,
  errorPrefix: string,
): Promise<number[][]> {
  const data = await response.json() as { data?: Array<{ embedding?: unknown; index?: unknown }> };
  const items = data.data;
  if (!Array.isArray(items)) {
    throw new Error(`${errorPrefix} embeddings response is missing a "data" array`);
  }
  if (items.length !== expectedCount) {
    throw new Error(
      `${errorPrefix} embeddings response returned ${items.length} embedding(s) for ${expectedCount} input(s)`,
    );
  }

  const sorted = [...items].sort((a, b) => {
    const indexA = typeof a.index === 'number' ? a.index : 0;
    const indexB = typeof b.index === 'number' ? b.index : 0;
    return indexA - indexB;
  });

  const vectors: number[][] = [];
  for (const item of sorted) {
    const vector = item.embedding;
    if (!Array.isArray(vector) || vector.length !== expectedDimensions || !vector.every(v => typeof v === 'number')) {
      const actualLength = Array.isArray(vector) ? vector.length : 'unknown';
      throw new Error(
        `${errorPrefix} embeddings response returned a vector of ${actualLength} dimensions, expected ${expectedDimensions}`,
      );
    }
    vectors.push(vector as number[]);
  }
  return vectors;
}

/**
 * Translates a classified `LlmRequestError` from the shared request executor
 * (`src/llm/client.ts`) into this codebase's existing embedding error
 * taxonomy — `rateLimited`/`embeddingUnavailable` `BrainError`s with the
 * exact code/message shape embedding callers (`StorageManager`,
 * `SearchService.semanticSearch`) already depend on. `genericPrefix` covers
 * the network/timeout/invalid-response fallback message, which historically
 * differs in wording between providers (OpenAI: "Embedding provider
 * unreachable: ..."; Azure: "Azure embedding provider unreachable: ...").
 */
export function classifyEmbeddingError(
  err: unknown,
  options: { errorPrefix: string; genericPrefix: string },
): BrainError {
  if (err instanceof BrainError) return err;

  if (err instanceof LlmRequestError) {
    if (err.code === 'rate_limited') {
      return rateLimited(`${options.errorPrefix} embeddings rate limited`);
    }
    if (err.status !== undefined && [400, 401, 403, 404].includes(err.status)) {
      return new BrainError('EMBEDDING_UNAVAILABLE', `${options.errorPrefix} embeddings request rejected (HTTP ${err.status})`, false);
    }
    if (err.status !== undefined && err.status >= 400 && err.status < 500) {
      return new BrainError('EMBEDDING_UNAVAILABLE', `${options.errorPrefix} embeddings client error ${err.status}`, false);
    }
    if (err.code === 'server_error') {
      return embeddingUnavailable(`${options.errorPrefix} embedding provider error ${err.status ?? 'unknown'}`);
    }
    if (err.code === 'invalid_response') {
      return new BrainError('EMBEDDING_UNAVAILABLE', `${options.genericPrefix}: ${err.message}`, false);
    }
    // timeout / network_error — retryability comes straight from the
    // classified failure, preserving the original cause instead of a
    // generic always-retryable flag (design.md Decision #6).
    return new BrainError('EMBEDDING_UNAVAILABLE', `${options.genericPrefix}: ${err.message}`, err.retryable);
  }

  return embeddingUnavailable(`${options.genericPrefix}: ${err instanceof Error ? err.message : 'Unknown error'}`);
}

/**
 * Canonical, provider-qualified embedding identity string:
 * `<provider>/<model>@<dimensions>`. Provider-qualified because the same
 * model name served by OpenAI vs an Azure deployment is not guaranteed
 * byte-identical; dimensions included because Matryoshka-truncated variants
 * of one model are different vector spaces. This is the single source of
 * truth for the identity format — every stamp (SQLite row, Qdrant payload,
 * the store's expected-identity record) is derived from this function so
 * the format can never drift between call sites.
 */
export function formatEmbeddingIdentity(provider: string, model: string, dimensions: number): string {
  return `${provider}/${model}@${dimensions}`;
}

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  // Provider-qualified identity for this provider's active configuration
  // (see formatEmbeddingIdentity). Stamped on every vector-producing write.
  readonly identity: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'openai';
  readonly model: string;
  readonly dimensions: number;
  readonly identity: string;
  private apiKey: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly maxBatchInputs: number;
  private readonly retry: LlmRetryConfig;

  constructor(
    config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
  ) {
    this.model = config.embedding.model;
    this.dimensions = config.embedding.dimensions;
    this.identity = formatEmbeddingIdentity(this.provider, this.model, this.dimensions);
    this.requestTimeoutMs = config.embedding.request_timeout_ms;
    this.maxBatchInputs = config.embedding.max_batch_inputs;
    this.retry = {
      maxAttempts: config.embedding.retry.max_attempts,
      backoffMs: config.embedding.retry.backoff_ms,
      maxBackoffMs: config.embedding.retry.max_backoff_ms ?? 10_000,
    };
    this.apiKey = requireApiKey(config.embedding.api_key_env);
    this.baseUrl = resolveLlmBaseUrl(config.llm?.base_url);
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  // unify-llm-client-boundaries task 2.4/2.5: routed through the shared
  // request executor (`src/llm/client.ts`) with response parsing/validation
  // as the executor's `parseResponse` callback — the deadline (and, when a
  // breaker is supplied, the breaker) now covers body read/parse/validation,
  // not just the initial fetch. Previously `parseEmbeddingsResponse` ran
  // *after* `requestEmbeddingsWithRetry` returned, outside the abort timer
  // it had already cleared: a provider that stalled mid-body never tripped
  // the deadline or the breaker. `max_batch_inputs` is now honored here too
  // (previously only the Azure provider chunked), and each chunk's response
  // is validated for exact input-count/dimension match before any vector is
  // trusted (task 2.5) — a short or malformed batch fails the whole call
  // instead of silently misassociating vectors with the wrong memories.
  async embedBatch(texts: string[]): Promise<number[][]> {
    const start = Date.now();
    try {
      const chunks = chunkInputs(texts, this.maxBatchInputs);
      const results: number[][] = [];
      for (const chunk of chunks) {
        results.push(...await this.requestEmbeddings(chunk, true));
      }
      return results;
    } catch (err) {
      throw classifyEmbeddingError(err, { errorPrefix: 'OpenAI', genericPrefix: 'Embedding provider unreachable' });
    } finally {
      this.metrics?.recordHistogram('embedding_embed_batch_ms', Date.now() - start);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Single-shot, bounded probe (respects requestTimeoutMs via the abort
      // controller in executeSingleLlmRequest) — no retry/backoff loop, no
      // breaker, mirroring AzureFoundryEmbeddingProvider.healthCheck().
      const response = await this.executeSingleRequest(['health check']);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw embeddingUnavailable(`Embedding API error ${response.status}: ${body.slice(0, 200)}`);
      }
      await parseAndValidateEmbeddingsResponse(response, 1, this.dimensions, 'OpenAI');
      return true;
    } catch {
      return false;
    }
  }

  private requestBody(texts: string[]): { model: string; input: string[] } {
    return { model: this.model, input: texts };
  }

  private requestHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async requestEmbeddings(texts: string[], useBreaker: boolean): Promise<number[][]> {
    return executeLlmRequest({
      url: `${this.baseUrl}/embeddings`,
      headers: this.requestHeaders(),
      body: this.requestBody(texts),
      timeoutMs: this.requestTimeoutMs,
      retry: this.retry,
      breaker: this.breaker,
      useBreaker,
      errorPrefix: 'OpenAI',
      parseResponse: async response => parseAndValidateEmbeddingsResponse(response, texts.length, this.dimensions, 'OpenAI'),
    });
  }

  private async executeSingleRequest(texts: string[]): Promise<Response> {
    return executeSingleLlmRequest({
      url: `${this.baseUrl}/embeddings`,
      headers: this.requestHeaders(),
      body: this.requestBody(texts),
      timeoutMs: this.requestTimeoutMs,
    });
  }
}

/**
 * Degraded embedding provider returned when credentials are unavailable.
 * Allows the server to start but rejects embedding-dependent operations at request time.
 */
export class DegradedEmbeddingProvider implements EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly identity: string;
  readonly degraded = true;

  constructor(config: BrainConfig) {
    this.provider = config.embedding.provider;
    this.model = config.embedding.model;
    this.dimensions = config.embedding.dimensions;
    this.identity = formatEmbeddingIdentity(this.provider, this.model, this.dimensions);
  }

  async embed(): Promise<number[]> {
    throw embeddingUnavailable('Embedding provider is unavailable: missing API credentials');
  }

  async embedBatch(): Promise<number[][]> {
    throw embeddingUnavailable('Embedding provider is unavailable: missing API credentials');
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }
}

export function getEmbeddingBreakerKey(provider: BrainConfig['embedding']['provider']): string {
  return provider === 'azure-foundry'
    ? 'azure_foundry_embedding'
    : 'openai_embedding';
}

/**
 * Emits a structured startup warning when the resolved embedding provider is
 * the degraded provider (e.g. missing credentials), honoring the project's
 * "no silent degradation" rule instead of leaving the condition to surface
 * only at a later request or health check.
 */
export function warnIfEmbeddingDegraded(
  embedding: EmbeddingProvider,
  config: BrainConfig,
  logger: { warn: (obj: Record<string, unknown>) => void },
): void {
  if (embedding instanceof DegradedEmbeddingProvider) {
    logger.warn({
      event: 'degraded_startup',
      provider: config.embedding.provider,
      reason: 'missing embedding provider credentials',
    });
  }
}

export function createEmbeddingProvider(
  config: BrainConfig,
  options?: { breaker?: CircuitBreaker; metrics?: MetricsCollector },
): EmbeddingProvider {
  switch (config.embedding.provider) {
    case 'openai':
      try {
        return new OpenAIEmbeddingProvider(config, options?.breaker, options?.metrics);
      } catch (error) {
        if (isMissingCredentialError(error)) {
          return new DegradedEmbeddingProvider(config);
        }
        throw error;
      }
    case 'azure-foundry':
      try {
        return new AzureFoundryEmbeddingProvider(config, options?.breaker, options?.metrics);
      } catch (error) {
        if (isMissingCredentialError(error)) {
          return new DegradedEmbeddingProvider(config);
        }
        throw error;
      }
    default:
      throw new Error(`Unknown embedding provider: ${config.embedding.provider}`);
  }
}
