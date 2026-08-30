import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { BrainError, embeddingUnavailable } from '../errors/index.js';
import { AzureFoundryEmbeddingProvider } from './azure-foundry.js';
import { executeSingleEmbeddingRequest, requestEmbeddingsWithRetry } from './request.js';

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

function isMissingCredentialError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Missing environment variable: ');
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
  private baseUrl = 'https://api.openai.com/v1';
  private readonly requestTimeoutMs: number;
  private readonly retryMaxAttempts: number;
  private readonly retryBackoffMs: number;

  constructor(
    config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
  ) {
    this.model = config.embedding.model;
    this.dimensions = config.embedding.dimensions;
    this.identity = formatEmbeddingIdentity(this.provider, this.model, this.dimensions);
    this.requestTimeoutMs = config.embedding.request_timeout_ms;
    this.retryMaxAttempts = config.embedding.retry.max_attempts;
    this.retryBackoffMs = config.embedding.retry.backoff_ms;
    const key = process.env[config.embedding.api_key_env];
    if (!key) {
      throw new Error(`Missing environment variable: ${config.embedding.api_key_env}`);
    }
    this.apiKey = key;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  // cut-embedding-and-qdrant-round-trips: routed through the shared
  // timeout/retry/classification helper (see ./request.ts) so
  // `request_timeout_ms` and `retry.*` apply identically to the Azure
  // provider — previously this issued a bare `fetch` with neither. A
  // classified error (e.g. rateLimited, a non-retryable BrainError) is
  // rethrown as-is rather than re-wrapped, mirroring the Azure provider so
  // callers see the same error taxonomy across providers; only an
  // unclassified failure (network error, timeout after retries exhausted)
  // gets wrapped as embeddingUnavailable here.
  async embedBatch(texts: string[]): Promise<number[][]> {
    const start = Date.now();
    try {
      const response = await this.requestEmbeddings(texts, true);
      return await this.parseEmbeddingsResponse(response);
    } catch (err) {
      if (err instanceof BrainError) {
        throw err;
      }
      throw embeddingUnavailable(`Embedding provider unreachable: ${getErrorMessage(err)}`);
    } finally {
      this.metrics?.recordHistogram('embedding_embed_batch_ms', Date.now() - start);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Single-shot, bounded probe (respects requestTimeoutMs via the abort
      // controller in executeSingleEmbeddingRequest) — no retry/backoff loop,
      // no breaker, mirroring AzureFoundryEmbeddingProvider.healthCheck().
      const response = await this.executeSingleRequest(['health check']);
      await this.parseEmbeddingsResponse(response);
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

  private async requestEmbeddings(texts: string[], useBreaker: boolean): Promise<Response> {
    return requestEmbeddingsWithRetry({
      url: `${this.baseUrl}/embeddings`,
      headers: this.requestHeaders(),
      body: this.requestBody(texts),
      timeoutMs: this.requestTimeoutMs,
      retry: { max_attempts: this.retryMaxAttempts, backoff_ms: this.retryBackoffMs },
      breaker: this.breaker,
      useBreaker,
      errorPrefix: 'OpenAI',
    });
  }

  private async executeSingleRequest(texts: string[]): Promise<Response> {
    return executeSingleEmbeddingRequest({
      url: `${this.baseUrl}/embeddings`,
      headers: this.requestHeaders(),
      body: this.requestBody(texts),
      timeoutMs: this.requestTimeoutMs,
    });
  }

  private async parseEmbeddingsResponse(response: Response): Promise<number[][]> {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw embeddingUnavailable(`Embedding API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
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
