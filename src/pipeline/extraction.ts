import { z } from 'zod';
import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';
import type { MemoryType } from '../domain/types.js';
import { MemoryTypeSchema } from '../domain/schemas.js';

/**
 * A single atomic fact split out of raw input by the extraction LLM.
 * `type`/`importance` are optional — the caller falls back to the original
 * write's `type`/`tags`/`importance` for any candidate that omits them (see
 * `WritePipeline.extract`).
 */
export interface RawCandidate {
  content: string;
  type?: MemoryType;
  importance?: number;
}

/**
 * Strict, all-or-nothing response validation: if any candidate in the batch
 * fails (missing content, empty-after-trim, out-of-range importance, unknown
 * type), the whole parse fails and the caller treats it identically to a
 * network failure — no partial trust of a malformed response.
 */
const ExtractionResponseSchema = z.object({
  candidates: z.array(z.object({
    content: z.string().trim().min(1),
    type: MemoryTypeSchema.optional(),
    importance: z.number().min(0).max(1).optional(),
  })).min(1),
});

const SYSTEM_PROMPT = `You split raw input text into atomic, self-contained candidate memories.

Rules:
- Each candidate must stand alone: understandable without the rest of the input.
- If the input already describes exactly one fact, return exactly one candidate,
  reproducing its content verbatim (do not paraphrase single-fact input).
- Split only on genuinely distinct facts, not sentence boundaries. Do not merge
  unrelated facts into one candidate.
- Do not invent content that is not present in the input.
- Optionally classify each candidate's "type" as one of: "episodic", "semantic",
  "procedural", and an "importance" between 0 and 1, if you are confident;
  otherwise omit those fields.

Respond with a JSON object of the exact shape:
{"candidates": [{"content": "...", "type": "semantic", "importance": 0.5}, ...]}`;

export interface ExtractionProvider {
  /**
   * Returns validated candidates for atomic, multi-fact input, or `null` to
   * signal "extraction not attempted / not usable" — the caller falls back
   * to today's deterministic single-candidate extraction in that case.
   * Never throws: every failure mode (network, timeout, malformed/empty
   * response) resolves to `null`.
   */
  extractCandidates(content: string): Promise<RawCandidate[] | null>;
}

interface ExtractionLogger {
  warn: (obj: Record<string, unknown>) => void;
}

export class LlmExtractionProvider implements ExtractionProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxCandidates: number;
  private readonly timeoutMs: number;
  private baseUrl = 'https://api.openai.com/v1';

  constructor(
    config: BrainConfig,
    apiKey: string,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
    private readonly logger?: ExtractionLogger,
  ) {
    this.apiKey = apiKey;
    this.model = config.pipeline.extraction_model;
    this.maxCandidates = config.pipeline.extraction_max_candidates;
    this.timeoutMs = config.pipeline.extraction_timeout_ms;
  }

  async extractCandidates(content: string): Promise<RawCandidate[] | null> {
    const start = Date.now();
    try {
      const raw = await this.callChatCompletion(content);
      const parsed = this.parseAndValidate(raw);
      if (!parsed) {
        this.metrics?.incCounter('extraction_fallback_total');
        return null;
      }

      const candidates = this.applyCandidateCap(parsed);
      return candidates;
    } catch (err) {
      this.logger?.warn({
        event: 'extraction_invalid_response',
        error: (err as Error).message,
      });
      this.metrics?.incCounter('extraction_fallback_total');
      return null;
    } finally {
      this.metrics?.recordHistogram('extraction_ms', Date.now() - start);
    }
  }

  private applyCandidateCap(candidates: RawCandidate[]): RawCandidate[] {
    if (candidates.length <= this.maxCandidates) {
      return candidates;
    }

    this.logger?.warn({
      event: 'extraction_candidates_truncated',
      total: candidates.length,
      kept: this.maxCandidates,
    });
    this.metrics?.incCounter('extraction_candidates_truncated_total');
    return candidates.slice(0, this.maxCandidates);
  }

  private parseAndValidate(raw: string): RawCandidate[] | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      this.logger?.warn({
        event: 'extraction_invalid_response',
        error: `malformed JSON: ${(err as Error).message}`,
      });
      return null;
    }

    const result = ExtractionResponseSchema.safeParse(json);
    if (!result.success) {
      this.logger?.warn({
        event: 'extraction_invalid_response',
        error: `schema validation failed: ${result.error.message}`,
      });
      return null;
    }

    return result.data.candidates;
  }

  private async callChatCompletion(content: string): Promise<string> {
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
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
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
        throw new Error(`Extraction API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      const message = data.choices[0]?.message.content;
      if (!message) {
        throw new Error('Extraction API response had no message content');
      }
      return message;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Degraded extraction provider: never contacts the network, always signals
 * "extraction not attempted" so `WritePipeline.extract` falls back to
 * today's deterministic single-candidate path. Used when extraction is
 * disabled or no API key resolves.
 */
export class NoopExtractionProvider implements ExtractionProvider {
  async extractCandidates(): Promise<RawCandidate[] | null> {
    return null;
  }
}

/**
 * Resolves the extraction API key exactly as documented: the configured
 * `extraction_model_env` var, falling back to `OPENAI_API_KEY` when unset.
 */
function resolveExtractionApiKey(config: BrainConfig): string | undefined {
  return process.env[config.pipeline.extraction_model_env] ?? process.env.OPENAI_API_KEY;
}

export function createExtractionProvider(
  config: BrainConfig,
  options?: { breaker?: CircuitBreaker; metrics?: MetricsCollector; logger?: ExtractionLogger },
): ExtractionProvider {
  if (!config.pipeline.extraction_enabled) {
    return new NoopExtractionProvider();
  }

  const apiKey = resolveExtractionApiKey(config);
  if (!apiKey) {
    return new NoopExtractionProvider();
  }

  return new LlmExtractionProvider(config, apiKey, options?.breaker, options?.metrics, options?.logger);
}

/**
 * Emits a structured startup warning when extraction is enabled but no
 * usable API key resolved (misconfigured), distinguishing that from
 * "deliberately off" (extraction_enabled: false), which warns nothing —
 * mirrors `warnIfEmbeddingDegraded`.
 */
export function warnIfExtractionDegraded(
  provider: ExtractionProvider,
  config: BrainConfig,
  logger: ExtractionLogger,
): void {
  if (config.pipeline.extraction_enabled && provider instanceof NoopExtractionProvider) {
    logger.warn({
      event: 'extraction_degraded_startup',
      reason: 'missing extraction provider credentials',
    });
  }
}
