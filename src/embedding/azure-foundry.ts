import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';
import { formatEmbeddingIdentity, chunkInputs, classifyEmbeddingError, parseAndValidateEmbeddingsResponse, type EmbeddingProvider } from './index.js';
import { executeLlmRequest, executeSingleLlmRequest, requireApiKey, type LlmRetryConfig } from '../llm/client.js';
import { embeddingUnavailable } from '../errors/index.js';

function shouldIncludeDimensions(model: string): boolean {
  return model === 'text-embedding-3-small' || model === 'text-embedding-3-large';
}

interface AzureEmbeddingsRequestBody {
  model: string;
  input: string[];
  dimensions?: number;
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
  private readonly retry: LlmRetryConfig;
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
    this.retry = {
      maxAttempts: config.embedding.retry.max_attempts,
      backoffMs: config.embedding.retry.backoff_ms,
      maxBackoffMs: config.embedding.retry.max_backoff_ms ?? 10_000,
    };

    if (!config.embedding.azure) {
      throw new Error('embedding.azure configuration is required for Azure provider');
    }
    const azureConfig = config.embedding.azure;

    const resourceName = azureConfig.resource_name;
    this.baseUrl = `https://${resourceName}.openai.azure.com/openai/v1`;

    // Azure retains its derived per-resource endpoint (never the shared
    // `llm.base_url`) — see design.md Decision #3 — but credential
    // resolution goes through the same shared helper as every other
    // feature, no OPENAI_API_KEY fallback (Azure and OpenAI keys are never
    // interchangeable).
    this.apiKey = requireApiKey(azureConfig.api_key_env);

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
        results.push(...await this.requestWithRetry(chunk, true));
      }

      return results;
    } catch (err) {
      throw classifyEmbeddingError(err, { errorPrefix: 'Azure', genericPrefix: 'Azure embedding provider unreachable' });
    } finally {
      this.metrics?.recordHistogram('embedding_embed_batch_ms', Date.now() - start);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Single-shot, bounded probe (respects requestTimeoutMs via the abort
      // controller in executeSingleLlmRequest) — no retry/backoff loop, mirroring
      // OpenAIEmbeddingProvider.healthCheck(). Bypasses the breaker entirely,
      // same as requestWithRetry(..., false).
      const response = await this.executeSingleRequest(['health check']);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw embeddingUnavailable(`Azure embedding API error ${response.status}: ${body.slice(0, 200)}`);
      }
      await parseAndValidateEmbeddingsResponse(response, 1, this.dimensions, 'Azure');
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
  // timeout/retry/classification/response-validation machinery to the shared
  // request executor (`src/llm/client.ts`) so it is identical to the OpenAI
  // provider's (unify-llm-client-boundaries task 2.4/2.5).
  private async requestWithRetry(texts: string[], useBreaker: boolean): Promise<number[][]> {
    return executeLlmRequest({
      url: `${this.baseUrl}/embeddings`,
      headers: this.requestHeaders(),
      body: this.buildRequestBody(texts),
      timeoutMs: this.requestTimeoutMs,
      retry: this.retry,
      breaker: this.breaker,
      useBreaker,
      errorPrefix: 'Azure',
      parseResponse: async response => parseAndValidateEmbeddingsResponse(response, texts.length, this.dimensions, 'Azure'),
    });
  }

  private async executeSingleRequest(texts: string[]): Promise<Response> {
    return executeSingleLlmRequest({
      url: `${this.baseUrl}/embeddings`,
      headers: this.requestHeaders(),
      body: this.buildRequestBody(texts),
      timeoutMs: this.requestTimeoutMs,
    });
  }
}
