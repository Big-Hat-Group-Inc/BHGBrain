import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { BrainError, embeddingUnavailable } from '../errors/index.js';
import { formatEmbeddingIdentity, type EmbeddingProvider } from './index.js';
import { executeSingleEmbeddingRequest, requestEmbeddingsWithRetry } from './request.js';

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
  readonly provider = 'azure-foundry';
  readonly model: string;
  readonly dimensions: number;
  readonly identity: string;
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
    this.identity = formatEmbeddingIdentity(this.provider, this.model, this.dimensions);
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
      // Single-shot, bounded probe (respects requestTimeoutMs via the abort
      // controller in executeSingleRequest) — no retry/backoff loop, mirroring
      // OpenAIEmbeddingProvider.healthCheck(). Bypasses the breaker entirely,
      // same as requestWithRetry(..., false).
      const response = await this.executeSingleRequest(['health check']);
      await this.parseEmbeddingsResponse(response);
      return true;
    } catch {
      return false;
    }
  }

  private buildRequestBody(texts: string[]): AzureEmbeddingsRequestBody {
    const body: AzureEmbeddingsRequestBody = {
      model: this.model,
      input: texts,
    };
    if (shouldIncludeDimensions(this.model)) {
      body.dimensions = this.dimensions;
    }
    return body;
  }

  private requestHeaders(): Record<string, string> {
    return {
      'api-key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  // Wraps the whole logical operation (all retry attempts) in a single breaker
  // call so one `embedBatch` records at most one breaker failure, regardless of
  // how many attempts `retry.max_attempts` allows internally. Delegates the
  // timeout/retry/classification machinery to the shared helper (see
  // ./request.ts) so it is identical to the OpenAI provider's.
  private async requestWithRetry(texts: string[], useBreaker: boolean): Promise<Response> {
    return requestEmbeddingsWithRetry({
      url: `${this.baseUrl}/embeddings`,
      headers: this.requestHeaders(),
      body: this.buildRequestBody(texts),
      timeoutMs: this.requestTimeoutMs,
      retry: { max_attempts: this.retryMaxAttempts, backoff_ms: this.retryBackoffMs },
      breaker: this.breaker,
      useBreaker,
      errorPrefix: 'Azure',
    });
  }

  private async executeSingleRequest(texts: string[]): Promise<Response> {
    return executeSingleEmbeddingRequest({
      url: `${this.baseUrl}/embeddings`,
      headers: this.requestHeaders(),
      body: this.buildRequestBody(texts),
      timeoutMs: this.requestTimeoutMs,
    });
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
}
