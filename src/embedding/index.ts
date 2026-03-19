import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { embeddingUnavailable } from '../errors/index.js';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private apiKey: string;
  private baseUrl = 'https://api.openai.com/v1';

  constructor(
    config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
  ) {
    this.model = config.embedding.model;
    this.dimensions = config.embedding.dimensions;
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
  readonly model: string;
  readonly dimensions: number;
  readonly degraded = true;

  constructor(config: BrainConfig) {
    this.model = config.embedding.model;
    this.dimensions = config.embedding.dimensions;
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

export function createEmbeddingProvider(
  config: BrainConfig,
  options?: { breaker?: CircuitBreaker; metrics?: MetricsCollector },
): EmbeddingProvider {
  switch (config.embedding.provider) {
    case 'openai':
      try {
        return new OpenAIEmbeddingProvider(config, options?.breaker, options?.metrics);
      } catch {
        // Missing credentials: start in degraded mode
        return new DegradedEmbeddingProvider(config);
      }
    default:
      throw new Error(`Unknown embedding provider: ${config.embedding.provider}`);
  }
}
