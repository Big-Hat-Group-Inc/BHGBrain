import { z } from 'zod';
import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { CircuitBreaker } from '../resilience/index.js';

// Small, fixed, deterministic English stopword set (add-multi-query-expansion
// Phase 1). No configurability beyond `keyword_stripped: boolean` to disable
// the whole variant — see design.md "Stopword-stripped variant guard rails".
const STOPWORDS = new Set([
  'a', 'an', 'the',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing',
  'how', 'what', 'when', 'where', 'why', 'who', 'whom', 'which',
  'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'about', 'as', 'by', 'from', 'up', 'down',
  'and', 'or', 'but', 'if', 'so', 'than', 'then', 'there', 'here',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'not', 'no', 'yes', 'also', 'just', 'very', 'too', 'again',
]);

function normalizeForStopwordCheck(word: string): string {
  return word.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
}

/**
 * Strips stopwords from `query`, returning `null` (a "skip this variant"
 * signal, not an empty string) when:
 * - the result is empty/whitespace-only (an all-stopword query, e.g. "is it"), or
 * - the result is identical (case-insensitively) to the trimmed original (an
 *   all-content-word query, where stripping would be a no-op variant).
 */
export function keywordStrippedVariant(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed === '') return null;

  const words = trimmed.split(/\s+/);
  const kept = words.filter(w => !STOPWORDS.has(normalizeForStopwordCheck(w)));
  if (kept.length === 0) return null;

  const result = kept.join(' ');
  if (result.toLowerCase() === trimmed.toLowerCase()) return null;
  return result;
}

/**
 * Builds the final, deduped, capped list of query variants to embed/search:
 * the trimmed original always first, then the keyword-stripped variant (if
 * enabled and non-degenerate), then any provided LLM variants — in that
 * order, so a fixed-cost deterministic variant never gets crowded out by
 * `max_variants` before an optional model-backed one. Comparison for dedup
 * is case-insensitive (design.md "Variant dedup").
 */
export function buildVariants(
  query: string,
  config: BrainConfig['search']['query_expansion'],
  llmVariants: string[] = [],
): string[] {
  const trimmedOriginal = query.trim();
  const variants: string[] = [trimmedOriginal];
  const seen = new Set([trimmedOriginal.toLowerCase()]);

  if (config.keyword_stripped) {
    const kw = keywordStrippedVariant(trimmedOriginal);
    if (kw !== null && !seen.has(kw.toLowerCase())) {
      variants.push(kw);
      seen.add(kw.toLowerCase());
    }
  }

  for (const raw of llmVariants) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    variants.push(trimmed);
    seen.add(key);
  }

  return variants.slice(0, config.max_variants);
}

export type QueryExpansionMode = 'paraphrase' | 'hyde';

export interface QueryExpansionLogger {
  warn: (obj: Record<string, unknown>) => void;
}

/**
 * Phase 2 (LLM paraphrase/HyDE) generator. `configured` reports whether an
 * API key resolved — a boolean/getter rather than a construction-time throw,
 * since phase 2 must be optional at runtime (design.md task 5.1): a missing
 * key means "skip LLM expansion", never "fail startup" or "fail this call".
 */
export interface QueryExpansionProvider {
  readonly configured: boolean;
  /**
   * Returns generated variant strings, or `[]` on any failure (missing
   * config, network error, timeout, non-2xx response, malformed response) —
   * never throws. Failures are counted/logged internally so callers can
   * treat the return value as the single source of truth.
   */
  generateVariants(query: string, mode: QueryExpansionMode, count: number, timeoutMs: number): Promise<string[]>;
}

const VariantsResponseSchema = z.object({
  variants: z.array(z.string().trim().min(1)),
});

function systemPromptFor(mode: QueryExpansionMode, count: number): string {
  if (mode === 'hyde') {
    return `Write ${count} short hypothetical passage(s) that would answer the user's query, ` +
      `as if each were an excerpt from a document that already contains the answer. Do not ` +
      `include disclaimers or mention that the passage is hypothetical. Respond with a JSON ` +
      `object of the exact shape {"variants": ["...", ...]} containing exactly ${count} ` +
      'passage(s).';
  }
  return `Reword the user's query in ${count} different way(s) that preserve its meaning and ` +
    'intent. Do not answer the query, only reword it. Respond with a JSON object of the exact ' +
    `shape {"variants": ["...", ...]} containing exactly ${count} reworded version(s).`;
}

/**
 * Resolves the phase-2 API key exactly as `pipeline.extraction_model_env` is
 * documented (README.md "Environment Variables"): the configured env var,
 * falling back to `OPENAI_API_KEY` when unset. Reuses the extraction hook
 * deliberately (design.md "Phase 2 credential resolution reuses the
 * extraction hook") rather than adding a parallel model/credential config.
 */
function resolveQueryExpansionApiKey(config: BrainConfig): string | undefined {
  return process.env[config.pipeline.extraction_model_env] ?? process.env.OPENAI_API_KEY;
}

/**
 * Raw-`fetch` client against the OpenAI-compatible Chat Completions
 * endpoint, modeled directly on `LlmExtractionProvider`
 * (`src/pipeline/extraction.ts`) and `OpenAISummarizationProvider`
 * (`src/summarization/index.ts`): API key resolved at construction,
 * request bounded by an `AbortController` timeout, optionally routed
 * through a `CircuitBreaker`. Uses `pipeline.extraction_model` for the
 * model name (no separate query-expansion model config — see design.md).
 */
export class LLMQueryExpansionProvider implements QueryExpansionProvider {
  readonly configured: boolean;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private baseUrl = 'https://api.openai.com/v1';

  constructor(
    config: BrainConfig,
    private readonly breaker?: CircuitBreaker,
    private readonly metrics?: MetricsCollector,
    private readonly logger?: QueryExpansionLogger,
  ) {
    this.model = config.pipeline.extraction_model;
    this.apiKey = resolveQueryExpansionApiKey(config);
    this.configured = this.apiKey !== undefined;
  }

  async generateVariants(
    query: string,
    mode: QueryExpansionMode,
    count: number,
    timeoutMs: number,
  ): Promise<string[]> {
    if (!this.configured || !this.apiKey) return [];

    const start = Date.now();
    try {
      const raw = await this.callChatCompletion(query, mode, count, timeoutMs, this.apiKey);
      const parsed = this.parseAndValidate(raw);
      if (!parsed) {
        this.degrade('malformed or invalid response');
        return [];
      }
      return parsed.slice(0, count);
    } catch (err) {
      this.degrade((err as Error).message);
      return [];
    } finally {
      this.metrics?.recordHistogram('search_query_expansion_llm_ms', Date.now() - start);
    }
  }

  private degrade(reason: string): void {
    this.metrics?.incCounter('search_query_expansion_llm_degraded');
    this.logger?.warn({ event: 'query_expansion_llm_degraded', reason });
  }

  private parseAndValidate(raw: string): string[] | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }

    const result = VariantsResponseSchema.safeParse(json);
    if (!result.success) return null;
    return result.data.variants;
  }

  private async callChatCompletion(
    query: string,
    mode: QueryExpansionMode,
    count: number,
    timeoutMs: number,
    apiKey: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const executeFetch = () => fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPromptFor(mode, count) },
          { role: 'user', content: query },
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
        throw new Error(`Query expansion API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      const message = data.choices[0]?.message.content;
      if (!message) {
        throw new Error('Query expansion API response had no message content');
      }
      return message;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createQueryExpansionProvider(
  config: BrainConfig,
  options?: { breaker?: CircuitBreaker; metrics?: MetricsCollector; logger?: QueryExpansionLogger },
): QueryExpansionProvider {
  return new LLMQueryExpansionProvider(config, options?.breaker, options?.metrics, options?.logger);
}

/**
 * Emits a structured startup warning when `llm_paraphrase.enabled` is true
 * but no usable API key resolved (a static misconfiguration), distinguishing
 * that from "deliberately off" (which warns nothing) — mirrors
 * `warnIfExtractionDegraded`/`warnIfSummarizationDegraded`. Deliberately not
 * called per-search: a missing key is a startup-time condition, not a
 * per-call one.
 */
export function warnIfQueryExpansionDegraded(
  provider: QueryExpansionProvider,
  config: BrainConfig,
  logger: QueryExpansionLogger,
): void {
  if (config.search.query_expansion.llm_paraphrase.enabled && !provider.configured) {
    logger.warn({
      event: 'query_expansion_degraded_startup',
      reason: 'missing extraction provider credentials',
    });
  }
}
