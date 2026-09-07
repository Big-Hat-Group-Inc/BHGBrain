import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import {
  executeLlmRequest,
  extractChatMessageContent,
  resolveApiKey,
  resolveLlmBaseUrl,
  resolveLlmRetryConfig,
  LlmRequestError,
} from '../llm/client.js';

const MAX_SUMMARY_CHARS = 120;

export type DistillationSkipReason = 'no_key' | 'llm_error';

/**
 * Typed, catchable error distinguishing "no API key configured" from every
 * other LLM failure mode (non-2xx, network error, unparseable/incomplete
 * response). `DistillationService` treats both reasons as "skip this
 * cluster, count it, keep going" — never a crash of the scheduled job or
 * the `bhgbrain distill` CLI command. See design.md Decision #4.
 */
/** Mirrors the config schema's own default (`retention.distillation.llm_timeout_ms`)
 * — used only when a hand-rolled `BrainConfig` (e.g. in tests) omits the
 * field entirely; a real Zod-parsed config always populates it. */
const DEFAULT_DISTILLATION_TIMEOUT_MS = 10_000;

export class DistillationLLMError extends Error {
  constructor(message: string, public readonly reason: DistillationSkipReason) {
    super(message);
    this.name = 'DistillationLLMError';
  }
}

export interface DistillationSourceMemory {
  content: string;
  updated_at: string;
}

export interface DistillationOutput {
  content: string;
  summary: string;
}

function isDistillationOutput(value: unknown): value is DistillationOutput {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as Record<string, unknown>).content === 'string' &&
    (value as { content: string }).content.trim().length > 0 &&
    typeof (value as Record<string, unknown>).summary === 'string' &&
    (value as { summary: string }).summary.trim().length > 0
  );
}

const SYSTEM_PROMPT = [
  'You consolidate a cluster of related episodic memories (individually observed facts,',
  'ordered oldest to newest) into ONE durable semantic fact that captures what is true',
  'now. Respond with exactly one JSON object and nothing else, of the shape:',
  '{"content": "<the consolidated fact, standalone and self-contained>",',
  ' "summary": "<a summary of at most 120 characters>"}',
  'If the sources disagree with each other, prefer whatever the most recently updated',
  'source states over older sources — this is not entailment/contradiction detection,',
  'just a recency tie-break. Do not include any text outside the JSON object.',
].join('\n');

function buildUserPrompt(memories: DistillationSourceMemory[]): string {
  const lines = memories.map((m, i) => `[${i + 1}] (updated_at: ${m.updated_at}) ${m.content}`);
  return `Consolidate these ${memories.length} related memories, oldest to newest:\n\n${lines.join('\n')}`;
}

/**
 * Minimal, single-purpose chat-completions client used only to turn one
 * cluster of episodic memory contents into one consolidated semantic-memory
 * draft. Routed through the shared OpenAI-compatible request boundary
 * (`src/llm/client.ts` — unify-llm-client-boundaries) exactly like every
 * other migrated chat feature, which fixes a real gap this call previously
 * had: no `AbortController`/deadline at all. A hung provider response used
 * to block `distill()` forever, and since `DistillationScheduler.runOnce`
 * awaits `DistillationService.runOnce` (which calls `distill()` per
 * cluster), a single hung call meant `scheduleNext()` — called only after
 * `runOnce` resolves — never ran again, silently ending every future
 * scheduled tick (task 2.2). `retention.distillation.llm_timeout_ms` now
 * bounds every attempt, covering body read/parse the same as the rest of
 * the shared boundary.
 */
export class DistillationLLMClient {
  constructor(
    private readonly config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
  ) {}

  async distill(memories: DistillationSourceMemory[]): Promise<DistillationOutput> {
    const envVar = this.config.pipeline.extraction_model_env;
    const apiKey = resolveApiKey(envVar, { fallbackToOpenAI: true });
    if (!apiKey) {
      throw new DistillationLLMError(`Missing environment variable: ${envVar}`, 'no_key');
    }

    const baseUrl = resolveLlmBaseUrl(this.config.llm?.base_url);
    const retry = resolveLlmRetryConfig(this.config.llm?.retry);

    const start = Date.now();
    try {
      return await executeLlmRequest({
        url: `${baseUrl}/chat/completions`,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: {
          model: this.config.pipeline.extraction_model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(memories) },
          ],
        },
        timeoutMs: this.config.retention?.distillation?.llm_timeout_ms ?? DEFAULT_DISTILLATION_TIMEOUT_MS,
        retry,
        breaker: this.breaker,
        useBreaker: this.breaker !== undefined,
        errorPrefix: 'Distillation LLM',
        parseResponse: async response => this.parseDistillationOutput(response),
      });
    } catch (err) {
      if (err instanceof DistillationLLMError) throw err;
      const message = err instanceof LlmRequestError ? err.message : (err as Error).message;
      throw new DistillationLLMError(`Distillation LLM call failed: ${message}`, 'llm_error');
    } finally {
      this.metrics?.recordHistogram('bhgbrain_distill_llm_call_ms', Date.now() - start);
    }
  }

  private async parseDistillationOutput(response: Response): Promise<DistillationOutput> {
    const raw = await extractChatMessageContent(response, 'Distillation LLM');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Distillation LLM message content is not valid JSON: ${(err as Error).message}`);
    }

    if (!isDistillationOutput(parsed)) {
      throw new Error('Distillation LLM response is missing required fields (content, summary)');
    }

    return {
      content: parsed.content,
      summary: parsed.summary.length > MAX_SUMMARY_CHARS
        ? parsed.summary.slice(0, MAX_SUMMARY_CHARS - 3) + '...'
        : parsed.summary,
    };
  }
}

/**
 * Emits a structured startup warning when scheduled distillation is enabled
 * but no usable API key resolves (extraction_model_env, falling back to
 * OPENAI_API_KEY) — mirrors `warnIfEntailmentDegraded`/
 * `warnIfExtractionDegraded`. Before this (task 3.2), a misconfigured
 * distillation deployment surfaced only as a per-cluster `no_key` skip
 * reason on the *next scheduled run* — up to a full `schedule` interval
 * (default: one day) after startup, and only if an operator was watching
 * `retention.distillation` health/logs closely enough to notice.
 */
export function warnIfDistillationDegraded(
  config: BrainConfig,
  logger: { warn: (obj: Record<string, unknown>) => void },
): void {
  if (!config.retention.distillation.enabled) return;

  const key = resolveApiKey(config.pipeline.extraction_model_env, { fallbackToOpenAI: true });
  if (!key) {
    logger.warn({
      event: 'distillation_degraded_startup',
      reason: 'missing extraction provider credentials',
    });
  }
}
