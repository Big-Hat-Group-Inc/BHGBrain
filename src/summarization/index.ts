import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';

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
  private baseUrl = 'https://api.openai.com/v1';

  constructor(
    config: BrainConfig,
    apiKey: string,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
  ) {
    this.apiKey = apiKey;
    this.model = config.pipeline.summarization_model;
    this.timeoutMs = config.pipeline.summarization_timeout_ms;
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

  private async callChatCompletion(content: string, maxLen: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const executeFetch = () => fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT_PREFIX} ${maxLen} characters.` },
          { role: 'user', content },
        ],
      }),
      signal: controller.signal,
    });

    try {
      const response = this.breaker
        ? await this.breaker.execute(executeFetch)
        : await executeFetch();

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Summarization API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      const message = data.choices[0]?.message.content;
      if (!message) {
        throw new Error('Summarization API response had no message content');
      }
      return message;
    } finally {
      clearTimeout(timer);
    }
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
 * `summarization_model_env` var (defaults to the same var extraction uses).
 */
function resolveSummarizationApiKey(config: BrainConfig): string | undefined {
  return process.env[config.pipeline.summarization_model_env];
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
