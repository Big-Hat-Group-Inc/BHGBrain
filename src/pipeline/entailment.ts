import type { BrainConfig } from '../config/index.js';
import type { CircuitBreaker } from '../resilience/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import { BrainError, internal } from '../errors/index.js';
import {
  executeLlmRequest,
  extractChatMessageContent,
  requireApiKey,
  resolveApiKey,
  resolveLlmBaseUrl,
  resolveLlmRetryConfig,
  LlmRequestError,
} from '../llm/client.js';

/**
 * Three-way relationship between an existing memory and a new candidate that
 * matched it within the UPDATE similarity band. Only `contradict` changes
 * pipeline behavior (routes to DELETE-and-replace); `agree`/`refine` both
 * fall through to the existing UPDATE merge. See
 * `openspec/changes/add-contradiction-detection/design.md`.
 */
export type EntailmentLabel = 'agree' | 'refine' | 'contradict';

const VALID_LABELS: readonly EntailmentLabel[] = ['agree', 'refine', 'contradict'];

const SYSTEM_PROMPT = [
  'You classify the relationship between an EXISTING memory and a CANDIDATE memory',
  'that a semantic search matched as highly similar. Respond with exactly one word,',
  'no punctuation, no explanation:',
  '- "agree" if the candidate restates the same fact as the existing memory',
  '  (a rephrase, with no new or conflicting information).',
  '- "refine" if the candidate adds detail, narrows scope, or elaborates on the',
  '  existing fact without asserting anything incompatible with it.',
  '- "contradict" if the candidate asserts something that cannot both be true at the',
  '  same time as the existing memory, meaning the existing fact is no longer',
  '  current or correct.',
  'If you are not confident the candidate contradicts the existing memory, respond',
  '"refine" rather than "contradict" — false contradictions are worse than missed',
  'ones. Respond with only the single word: agree, refine, or contradict.',
].join('\n');

interface EntailmentLogger {
  warn: (obj: Record<string, unknown>) => void;
}

/**
 * Minimal, single-purpose chat-completions call used only for the three-way
 * entailment classification below, routed through the shared OpenAI-
 * compatible request boundary (`src/llm/client.ts` — unify-llm-client-
 * boundaries) so it gets the same base-URL resolution, deadline-through-
 * body-parse coverage, HTTP/network classification, capped-jitter retry, and
 * (when a breaker is supplied) circuit-breaker integration as every other
 * migrated chat feature — previously this was the one migrated-later
 * outlier: a bare `fetch` with a timeout but no retry, no breaker, and no
 * metrics (task 2.1).
 *
 * Always throws a `BrainError` (never resolves to a value outside
 * `EntailmentLabel`) on timeout, network error, non-2xx response, or an
 * unparseable/off-list response — the caller in `src/pipeline/index.ts` is
 * expected to catch it and fail open rather than silently treat a malformed
 * response as `contradict`. The thrown `BrainError.retryable` mirrors the
 * underlying classified failure (design.md Decision #6: "Preserve original
 * classified errors at feature boundaries") so the caller's fail-open
 * telemetry retains the real cause instead of a generic flag.
 */
export async function checkEntailment(
  existing: string,
  candidate: string,
  config: BrainConfig,
  breaker?: CircuitBreaker,
  metrics?: MetricsCollector,
  logger?: EntailmentLogger,
): Promise<EntailmentLabel> {
  const timeoutMs = config.pipeline.contradiction_detection.timeout_ms;
  const baseUrl = resolveLlmBaseUrl(config.llm?.base_url);
  const retry = resolveLlmRetryConfig(config.llm?.retry);

  const start = Date.now();
  try {
    const apiKey = requireApiKey(config.pipeline.extraction_model_env, { fallbackToOpenAI: true });

    const label = await executeLlmRequest({
      url: `${baseUrl}/chat/completions`,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        model: config.pipeline.extraction_model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `EXISTING memory: ${existing}\nCANDIDATE memory: ${candidate}` },
        ],
      },
      timeoutMs,
      retry,
      breaker,
      useBreaker: breaker !== undefined,
      errorPrefix: 'Entailment check',
      parseResponse: async response => {
        const raw = await extractChatMessageContent(response, 'Entailment check');
        const normalized = raw.trim().toLowerCase();
        const label = VALID_LABELS.find(candidateLabel => candidateLabel === normalized);
        if (!label) {
          throw new Error(`Entailment check returned an unrecognized label: ${JSON.stringify(normalized).slice(0, 100)}`);
        }
        return label;
      },
    });

    metrics?.incCounter('entailment_check_total', 1, { result: label });
    return label;
  } catch (err) {
    if (err instanceof LlmRequestError) {
      metrics?.incCounter('entailment_check_failed_total', 1, { code: err.code });
      logger?.warn({
        event: 'entailment_check_failed',
        code: err.code,
        retryable: err.retryable,
        status: err.status,
        error: err.message,
      });
      throw new BrainError('INTERNAL', `Entailment check failed: ${err.message}`, err.retryable);
    }
    if (err instanceof BrainError) {
      metrics?.incCounter('entailment_check_failed_total', 1, { code: err.code });
      throw err;
    }
    metrics?.incCounter('entailment_check_failed_total', 1, { code: 'unknown' });
    throw internal(`Entailment check failed: ${(err as Error).message}`);
  } finally {
    metrics?.recordHistogram('entailment_check_ms', Date.now() - start);
  }
}

/**
 * Emits a structured startup warning when `contradiction_detection.enabled`
 * is `true` but no usable API key resolves (extraction_model_env, falling
 * back to OPENAI_API_KEY) — mirrors `warnIfExtractionDegraded`/
 * `warnIfSummarizationDegraded`/`warnIfQueryExpansionDegraded`. Before this
 * (task 3.2), a misconfigured contradiction-detection deployment surfaced
 * only as a per-write `contradiction_check_degraded` warning on the first
 * UPDATE-band candidate — a real but easy-to-miss signal buried in request
 * logs rather than a one-time, actionable startup diagnostic.
 */
export function warnIfEntailmentDegraded(
  config: BrainConfig,
  logger: EntailmentLogger,
): void {
  if (!config.pipeline.contradiction_detection.enabled) return;

  const key = resolveApiKey(config.pipeline.extraction_model_env, { fallbackToOpenAI: true });
  if (!key) {
    logger.warn({
      event: 'entailment_degraded_startup',
      reason: 'missing extraction provider credentials',
    });
  }
}
