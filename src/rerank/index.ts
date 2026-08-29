import { z } from 'zod';
import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';

// A single recall candidate as offered to the rerank provider: only the
// fields the LLM needs to judge relevance, never the full SearchResult (no
// scores, tags, or metadata leak into the prompt).
export interface RerankCandidate {
  id: string;
  text: string;
}

/**
 * Mirrors `EmbeddingProvider`'s shape (`src/embedding/index.ts:25-35`): a
 * small interface so `SearchService` depends on an abstraction, not a
 * concrete HTTP client, and so tests can substitute a stub. `score` never
 * throws away request identity — every entry in the returned `Map` is keyed
 * by the candidate `id` the caller supplied.
 */
export interface RerankProvider {
  readonly provider: string;
  /**
   * Scores each candidate's relevance to `query` in `[0, 1]`. The returned
   * `Map` may omit candidates the underlying response didn't score (or
   * scored with an id the caller never requested) — callers must keep such
   * candidates at their pre-rerank score rather than treating absence as a
   * zero score. Rejects (never resolves to a partial/garbage `Map`) on
   * network error, timeout, a non-2xx response, or a response that fails
   * JSON parsing / schema validation.
   */
  score(query: string, candidates: RerankCandidate[]): Promise<Map<string, number>>;
}

function isMissingCredentialError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Missing environment variable: ');
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

const RerankResponseSchema = z.object({
  scores: z.array(z.object({ id: z.string(), score: z.number() })),
});

const RERANK_SYSTEM_PROMPT =
  'You are a relevance-scoring assistant. You will receive a JSON object with a "query" ' +
  'string and a "candidates" array of {"id", "text"} objects. For each candidate, judge how ' +
  'relevant its text is to answering or satisfying the query, on a scale from 0 (irrelevant) ' +
  'to 1 (highly relevant). Respond with a JSON object of the exact shape ' +
  '{"scores": [{"id": "...", "score": 0.0}, ...]} containing exactly one entry per candidate, ' +
  'in any order. Do not include any other text.';

/**
 * One batched chat-completions call per `score()` invocation, reusing the
 * `fetch`-based HTTP pattern already established by
 * `OpenAIEmbeddingProvider.requestEmbeddings` (`src/embedding/index.ts:87-105`)
 * and `LLMQueryExpansionProvider.callChatCompletion`
 * (`src/search/query-expansion.ts:205-253`): same header shape, same
 * circuit-breaker-wrapped `fetch`, an `AbortController` timeout bounded by
 * `config.search.rerank.timeout_ms`, no new npm dependency.
 */
export class OpenAiRerankProvider implements RerankProvider {
  readonly provider = 'openai';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private baseUrl = 'https://api.openai.com/v1';

  constructor(
    config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
  ) {
    this.model = config.search.rerank.model;
    this.timeoutMs = config.search.rerank.timeout_ms;
    const key = process.env[config.search.rerank.model_env];
    if (!key) {
      throw new Error(`Missing environment variable: ${config.search.rerank.model_env}`);
    }
    this.apiKey = key;
  }

  async score(query: string, candidates: RerankCandidate[]): Promise<Map<string, number>> {
    const start = Date.now();
    try {
      const raw = await this.callChatCompletion(query, candidates);
      return this.parseAndValidate(raw, candidates);
    } finally {
      this.metrics?.recordHistogram('search_rerank_ms', Date.now() - start);
    }
  }

  private async callChatCompletion(query: string, candidates: RerankCandidate[]): Promise<string> {
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
          { role: 'system', content: RERANK_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ query, candidates }) },
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
        throw new Error(`Rerank API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      const message = data.choices[0]?.message.content;
      if (!message) {
        throw new Error('Rerank API response had no message content');
      }
      return message;
    } finally {
      clearTimeout(timer);
    }
  }

  // Parses/validates the raw chat-completions message content and narrows it
  // to a `Map` keyed only by ids the caller actually requested — a candidate
  // the LLM invents an id for is silently dropped, never trusted. A JSON
  // parse failure or schema mismatch rejects the whole call (task 5.1:
  // "rejects on ... malformed JSON") rather than returning a partial map, so
  // the caller (`SearchService.rerank`) can distinguish "the provider is
  // broken, fall back entirely" from "the provider scored some candidates
  // but not others" (task 2.4's partial-response case, which stays inside a
  // successfully-resolved `Map`).
  private parseAndValidate(raw: string, candidates: RerankCandidate[]): Map<string, number> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error('Rerank API response was not valid JSON');
    }

    const result = RerankResponseSchema.safeParse(json);
    if (!result.success) {
      throw new Error('Rerank API response failed schema validation');
    }

    const validIds = new Set(candidates.map(c => c.id));
    const scores = new Map<string, number>();
    for (const entry of result.data.scores) {
      if (!validIds.has(entry.id)) continue;
      scores.set(entry.id, clamp01(entry.score));
    }
    return scores;
  }
}

/**
 * Degraded rerank provider returned when reranking is enabled but no usable
 * API key resolved. Mirrors `DegradedEmbeddingProvider`
 * (`src/embedding/index.ts:127-152`): allows the server to start, and
 * `score()` always rejects so the caller's existing degrade-on-error path
 * (`SearchService.rerank`) handles it without a separate code path.
 */
export class DegradedRerankProvider implements RerankProvider {
  readonly provider: string;
  readonly degraded = true;

  constructor(config: BrainConfig) {
    this.provider = config.search.rerank.provider;
  }

  async score(): Promise<Map<string, number>> {
    throw new Error('Rerank provider is unavailable: missing API credentials');
  }
}

export function createRerankProvider(
  config: BrainConfig,
  options?: { breaker?: CircuitBreaker; metrics?: MetricsCollector },
): RerankProvider {
  switch (config.search.rerank.provider) {
    case 'openai':
      try {
        return new OpenAiRerankProvider(config, options?.breaker, options?.metrics);
      } catch (error) {
        if (isMissingCredentialError(error)) {
          return new DegradedRerankProvider(config);
        }
        throw error;
      }
    default: {
      const unsupported: never = config.search.rerank.provider;
      throw new Error(`Unknown rerank provider: ${unsupported as string}`);
    }
  }
}

/**
 * Emits a structured startup warning when reranking is enabled but resolved
 * to the degraded provider (missing credentials) — mirrors
 * `warnIfEmbeddingDegraded`/`warnIfQueryExpansionDegraded`, honoring the
 * project's "no silent degradation" rule instead of leaving the condition to
 * surface only at the first `recall` call.
 */
export function warnIfRerankDegraded(
  provider: RerankProvider,
  config: BrainConfig,
  logger: { warn: (obj: Record<string, unknown>) => void },
): void {
  if (config.search.rerank.enabled && provider instanceof DegradedRerankProvider) {
    logger.warn({
      event: 'rerank_degraded_startup',
      provider: config.search.rerank.provider,
      reason: 'missing rerank provider credentials',
    });
  }
}
