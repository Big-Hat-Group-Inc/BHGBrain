import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { embeddingUnavailable } from '../errors/index.js';
import { AzureFoundryEmbeddingProvider } from './azure-foundry.js';

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

  constructor(
    config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
  ) {
    this.model = config.embedding.model;
    this.dimensions = config.embedding.dimensions;
    this.identity = formatEmbeddingIdentity(this.provider, this.model, this.dimensions);
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

  async embedBatch(texts: string[]): Promise<number[][]> {
    const start = Date.now();
    try {
      const response = await this.requestEmbeddings(texts, true);
      return await this.parseEmbeddingsResponse(response);
    } catch (err) {
      throw embeddingUnavailable(`Embedding provider unreachable: ${(err as Error).message}`);
    } finally {
      this.metrics?.recordHistogram('embedding_embed_batch_ms', Date.now() - start);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.requestEmbeddings(['health check'], false);
      await this.parseEmbeddingsResponse(response);
      return true;
    } catch {
      return false;
    }
  }

  private async requestEmbeddings(texts: string[], useBreaker: boolean): Promise<Response> {
    const executeFetch = () => fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (useBreaker && this.breaker) {
      return this.breaker.execute(executeFetch);
    }

    return executeFetch();
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
