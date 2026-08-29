import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';
import type { MetricsCollector } from '../health/metrics.js';

const MAX_SUMMARY_CHARS = 120;

export type DistillationSkipReason = 'no_key' | 'llm_error';

/**
 * Typed, catchable error distinguishing "no API key configured" from every
 * other LLM failure mode (non-2xx, network error, unparseable/incomplete
 * response). `DistillationService` treats both reasons as "skip this
 * cluster, count it, keep going" — never a crash of the scheduled job or
 * the `bhgbrain distill` CLI command. See design.md Decision #4.
 */
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
 * draft. Mirrors `OpenAIEmbeddingProvider`'s constructor/circuit-breaker/
 * metrics shape (`src/embedding/index.ts`) and `checkEntailment`'s
 * fetch/timeout/error-typing pattern (`src/pipeline/entailment.ts`), but is
 * not a reusable extraction framework — see design.md Decision #1.
 */
export class DistillationLLMClient {
  private baseUrl = 'https://api.openai.com/v1';

  constructor(
    private readonly config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
  ) {}

  async distill(memories: DistillationSourceMemory[]): Promise<DistillationOutput> {
    const envVar = this.config.pipeline.extraction_model_env;
    const apiKey = process.env[envVar] ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new DistillationLLMError(`Missing environment variable: ${envVar}`, 'no_key');
    }

    const start = Date.now();
    try {
      const response = await this.request(memories, apiKey);
      return await this.parseResponse(response);
    } catch (err) {
      if (err instanceof DistillationLLMError) throw err;
      throw new DistillationLLMError(
        `Distillation LLM call failed: ${(err as Error).message}`,
        'llm_error',
      );
    } finally {
      this.metrics?.recordHistogram('bhgbrain_distill_llm_call_ms', Date.now() - start);
    }
  }

  private async request(memories: DistillationSourceMemory[], apiKey: string): Promise<Response> {
    const executeFetch = () => fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.pipeline.extraction_model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(memories) },
        ],
      }),
    });

    if (this.breaker) {
      return this.breaker.execute(executeFetch);
    }
    return executeFetch();
  }

  private async parseResponse(response: Response): Promise<DistillationOutput> {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new DistillationLLMError(
        `Distillation LLM API error ${response.status}: ${body.slice(0, 200)}`,
        'llm_error',
      );
    }

    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    } catch (err) {
      throw new DistillationLLMError(
        `Distillation LLM returned unparseable JSON: ${(err as Error).message}`,
        'llm_error',
      );
    }

    const raw = data.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new DistillationLLMError('Distillation LLM response has no message content', 'llm_error');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new DistillationLLMError(
        `Distillation LLM message content is not valid JSON: ${(err as Error).message}`,
        'llm_error',
      );
    }

    if (!isDistillationOutput(parsed)) {
      throw new DistillationLLMError(
        'Distillation LLM response is missing required fields (content, summary)',
        'llm_error',
      );
    }

    return {
      content: parsed.content,
      summary: parsed.summary.length > MAX_SUMMARY_CHARS
        ? parsed.summary.slice(0, MAX_SUMMARY_CHARS - 3) + '...'
        : parsed.summary,
    };
  }
}
