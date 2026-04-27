import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { BrainError, embeddingUnavailable, rateLimited } from '../errors/index.js';
import type { EmbeddingProvider } from './index.js';

function shouldIncludeDimensions(model: string): boolean {
  return model === 'text-embedding-3-small' || model === 'text-embedding-3-large';
}

function chunkInputs<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

interface AzureEmbeddingsRequestBody {
  model: string;
  input: string[];
  dimensions?: number;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

export class AzureFoundryEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly maxBatchInputs: number;
  private readonly retryMaxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly breaker?: CircuitBreaker;
  private readonly metrics?: MetricsCollector;

  constructor(
    config: BrainConfig,
    breaker?: CircuitBreaker,
    metrics?: MetricsCollector,
  ) {
    this.model = config.embedding.model;
    this.dimensions = config.embedding.dimensions;
    this.requestTimeoutMs = config.embedding.request_timeout_ms;
    this.maxBatchInputs = config.embedding.max_batch_inputs;
    this.retryMaxAttempts = config.embedding.retry.max_attempts;
    this.retryBackoffMs = config.embedding.retry.backoff_ms;

    if (!config.embedding.azure) {
      throw new Error('embedding.azure configuration is required for Azure provider');
    }
    const azureConfig = config.embedding.azure;

    const resourceName = azureConfig.resource_name;
    this.baseUrl = `https://${resourceName}.openai.azure.com/openai/v1`;

    const keyEnv = azureConfig.api_key_env;
    const key = process.env[keyEnv];
    if (!key) {
      throw new Error(`Missing environment variable: ${keyEnv}`);
    }
    this.apiKey = key;

    this.breaker = breaker;
    this.metrics = metrics;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const start = Date.now();
    try {
      const chunks = chunkInputs(texts, this.maxBatchInputs);
      const results: number[][] = [];

      for (const chunk of chunks) {
        const response = await this.requestWithRetry(chunk, true);
        const embeddings = await this.parseEmbeddingsResponse(response);
        results.push(...embeddings);
      }

      return results;
    } catch (err) {
      if (err instanceof BrainError) {
        throw err;
      }
      throw embeddingUnavailable(`Azure embedding provider unreachable: ${getErrorMessage(err)}`);
    } finally {
      this.metrics?.recordHistogram('embedding_embed_batch_ms', Date.now() - start);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.requestWithRetry(['health check'], false);
      await this.parseEmbeddingsResponse(response);
      return true;
    } catch {
      return false;
    }
  }

  private async requestWithRetry(texts: string[], useBreaker: boolean): Promise<Response> {
    const executeRequest = async (attempt: number): Promise<Response> => {
      try {
        const response = await this.executeSingleRequest(texts, useBreaker);
        if (response.ok) {
          return response;
        }

        const status = response.status;
        if (status === 429) {
          throw rateLimited('Azure embeddings rate limited');
        }

        if (status >= 500 && status < 600) {
          throw embeddingUnavailable(`Azure embedding provider error ${status}`);
        }

        // Non-retryable errors
        if ([400, 401, 403, 404].includes(status)) {
          throw new BrainError('EMBEDDING_UNAVAILABLE', `Azure embeddings request rejected (HTTP ${status})`, false);
        }

        // Other 4xx errors are not retryable
        if (status >= 400 && status < 500) {
          throw new BrainError('EMBEDDING_UNAVAILABLE', `Azure embeddings client error ${status}`, false);
        }

        // Should not happen
        throw embeddingUnavailable(`Azure embeddings unexpected status ${status}`);
      } catch (err) {
        // Determine if error is retryable
        const isRetryable = this.isRetryableError(err);
        if (!isRetryable || attempt >= this.retryMaxAttempts) {
          throw err;
        }

        // Wait with exponential backoff
        const delay = this.retryBackoffMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        return executeRequest(attempt + 1);
      }
    };

    return executeRequest(1);
  }

  private async executeSingleRequest(texts: string[], useBreaker: boolean): Promise<Response> {
    const executeFetch = () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      const body: AzureEmbeddingsRequestBody = {
        model: this.model,
        input: texts,
      };
      if (shouldIncludeDimensions(this.model)) {
        body.dimensions = this.dimensions;
      }

      return fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
    };

    if (useBreaker && this.breaker) {
      return this.breaker.execute(executeFetch);
    }

    return executeFetch();
  }

  private async parseEmbeddingsResponse(response: Response): Promise<number[][]> {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw embeddingUnavailable(`Azure embedding API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }

  private isRetryableError(err: unknown): boolean {
    if (err instanceof BrainError) {
      return err.retryable;
    }
    if (err instanceof Error) {
      return err.name === 'AbortError' || err instanceof TypeError || /fetch|network/i.test(err.message);
    }
    return false;
  }
}
