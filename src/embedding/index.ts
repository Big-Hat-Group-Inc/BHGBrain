import type { BrainConfig } from '../config/index.js';
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

  constructor(config: BrainConfig) {
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
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
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
    } catch (err) {
      throw embeddingUnavailable(`Embedding provider unreachable: ${(err as Error).message}`);
    }

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

  async healthCheck(): Promise<boolean> {
    try {
      await this.embed('health check');
      return true;
    } catch {
      return false;
    }
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

export function createEmbeddingProvider(config: BrainConfig): EmbeddingProvider {
  switch (config.embedding.provider) {
    case 'openai':
      try {
        return new OpenAIEmbeddingProvider(config);
      } catch {
        // Missing credentials: start in degraded mode
        return new DegradedEmbeddingProvider(config);
      }
    default:
      throw new Error(`Unknown embedding provider: ${config.embedding.provider}`);
  }
}
