import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';
import {
  executeLlmRequest,
  extractChatMessageContent,
  resolveApiKey,
  resolveLlmBaseUrl,
  resolveLlmRetryConfig,
} from '../llm/client.js';

/**
 * LLM-backed summarization provider interface. `summarize` never resolves
 * with content longer than `maxLen` — implementations hard-truncate before
 * returning, since the model's output is a hint, not a guarantee (see
 * improve-memory-summarization design.md).
 */
export interface SummarizationProvider {
  summarize(content: string, maxLen: number): Promise<string>;
}

const SYSTEM_PROMPT_PREFIX = 'Respond with exactly one plain-text sentence summarizing the input, ' +
  'no preface or quotation marks, under';

function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.substring(0, maxLen - 3) + '...';
}

/**
 * OpenAI Chat Completions-backed summarizer. Mirrors the shape of
 * `OpenAIEmbeddingProvider` (`src/embedding/index.ts`) and
 * `LlmExtractionProvider` (`src/pipeline/extraction.ts`): API key resolved at
 * construction time, request bounded by an `AbortController` timeout,
 * optionally routed through a `CircuitBreaker`.
 */
export class OpenAISummarizationProvider implements SummarizationProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly retry: ReturnType<typeof resolveLlmRetryConfig>;

  constructor(
    config: BrainConfig,
    apiKey: string,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
  ) {
    this.apiKey = apiKey;
    this.model = config.pipeline.summarization_model;
    this.timeoutMs = config.pipeline.summarization_timeout_ms;
    this.baseUrl = resolveLlmBaseUrl(config.llm?.base_url);
    this.retry = resolveLlmRetryConfig(config.llm?.retry);
  }

  async summarize(content: string, maxLen: number): Promise<string> {
    const start = Date.now();
    try {
      const raw = await this.callChatCompletion(content, maxLen);
      return truncate(raw, maxLen);
    } finally {
      this.metrics?.recordHistogram('summarization_ms', Date.now() - start);
    }
  }

  // unify-llm-client-boundaries task 2.3: routed through the shared
  // OpenAI-compatible request executor — same base URL resolution,
  // deadline-through-body-parse coverage, HTTP/network classification, and
  // capped-jitter retry as every other migrated chat feature. The breaker
  // now wraps the whole retry loop (one outcome per `summarize()` call).
  private async callChatCompletion(content: string, maxLen: number): Promise<string> {
    return executeLlmRequest({
      url: `${this.baseUrl}/chat/completions`,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        model: this.model,
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT_PREFIX} ${maxLen} characters.` },
          { role: 'user', content },
        ],
      },
      timeoutMs: this.timeoutMs,
      retry: this.retry,
      breaker: this.breaker,
      useBreaker: this.breaker !== undefined,
      errorPrefix: 'Summarization',
      parseResponse: async response => extractChatMessageContent(response, 'Summarization'),
    });
  }
}

/**
 * Degraded summarization provider returned when credentials are unavailable.
 * `summarize()` always rejects, mirroring `DegradedEmbeddingProvider`
 * (`src/embedding/index.ts`) — constructed rather than thrown at startup, so
 * a missing optional key never fails the server, only this tier's requests.
 */
export class DegradedSummarizationProvider implements SummarizationProvider {
  readonly degraded = true;

  async summarize(): Promise<string> {
    throw new Error('Summarization provider is unavailable: missing API credentials');
  }
}

/**
 * Resolves the summarization API key: the configured
 * `summarization_model_env` var (defaults to the same var extraction uses),
 * falling back to `OPENAI_API_KEY` when unset — matching the documented
 * fallback for `BHGBRAIN_EXTRACTION_API_KEY` (README.md "Environment
 * Variables") and the outbound-ai-request-policy spec scenario "Only the
 * common API key is set" (unify-llm-client-boundaries task 1.2). Before this
 * fix, an operator who set only `OPENAI_API_KEY` and enabled summarization
 * got `DegradedSummarizationProvider` instead of a working provider, unlike
 * every sibling feature (extraction, query expansion, entailment,
 * distillation) that already falls back the same way.
 */
function resolveSummarizationApiKey(config: BrainConfig): string | undefined {
  return resolveApiKey(config.pipeline.summarization_model_env, { fallbackToOpenAI: true });
}

/**
 * Returns `undefined` when `pipeline.summarization_enabled` is `false` — no
 * provider is constructed at all, so the default write path never touches
 * this module (mirrors `createEmbeddingProvider`'s shape, but embedding is
 * mandatory so it never returns `undefined`; summarization is optional so it
 * does).
 */
export function createSummarizationProvider(
  config: BrainConfig,
  options?: { breaker?: CircuitBreaker; metrics?: MetricsCollector },
): SummarizationProvider | undefined {
  if (!config.pipeline.summarization_enabled) {
    return undefined;
  }

  const apiKey = resolveSummarizationApiKey(config);
  if (!apiKey) {
    return new DegradedSummarizationProvider();
  }

  return new OpenAISummarizationProvider(config, apiKey, options?.breaker, options?.metrics);
}

/**
 * Emits a structured startup warning when summarization is enabled but no
 * usable API key resolved (misconfigured) — mirrors
 * `warnIfEmbeddingDegraded`/`warnIfExtractionDegraded`.
 */
export function warnIfSummarizationDegraded(
  provider: SummarizationProvider | undefined,
  config: BrainConfig,
  logger: { warn: (obj: Record<string, unknown>) => void },
): void {
  if (config.pipeline.summarization_enabled && provider instanceof DegradedSummarizationProvider) {
    logger.warn({
      event: 'summarization_degraded_startup',
      reason: 'missing summarization provider credentials',
    });
  }
}
