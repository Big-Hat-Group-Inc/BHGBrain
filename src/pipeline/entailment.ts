import type { BrainConfig } from '../config/index.js';
import { BrainError, internal } from '../errors/index.js';

/**
 * Three-way relationship between an existing memory and a new candidate that
 * matched it within the UPDATE similarity band. Only `contradict` changes
 * pipeline behavior (routes to DELETE-and-replace); `agree`/`refine` both
 * fall through to the existing UPDATE merge. See
 * `openspec/changes/add-contradiction-detection/design.md`.
 */
export type EntailmentLabel = 'agree' | 'refine' | 'contradict';

const VALID_LABELS: readonly EntailmentLabel[] = ['agree', 'refine', 'contradict'];

const CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

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

/**
 * Minimal, single-purpose chat-completions call used only for the three-way
 * entailment classification below. Modeled on the `fetch`-based pattern in
 * `OpenAIEmbeddingProvider` (`src/embedding/index.ts`): resolve the API key
 * from the env var named by config, POST JSON, parse JSON back. Not a
 * reusable extraction framework — see design.md Decisions, "Prerequisite /
 * gating", option 2.
 *
 * Always throws a `BrainError` (never resolves to a value outside
 * `EntailmentLabel`) on timeout, network error, non-2xx response, or an
 * unparseable/off-list response — the caller in `src/pipeline/index.ts` is
 * expected to catch it and fail open rather than silently treat a malformed
 * response as `contradict`.
 */
export async function checkEntailment(
  existing: string,
  candidate: string,
  config: BrainConfig,
): Promise<EntailmentLabel> {
  const apiKey = process.env[config.pipeline.extraction_model_env];
  if (!apiKey) {
    throw internal(`Missing environment variable: ${config.pipeline.extraction_model_env}`);
  }

  const timeoutMs = config.pipeline.contradiction_detection.timeout_ms;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.pipeline.extraction_model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `EXISTING memory: ${existing}\nCANDIDATE memory: ${candidate}` },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw internal(`Entailment check timed out after ${timeoutMs}ms`);
      }
      throw internal(`Entailment check request failed: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw internal(`Entailment check API error ${response.status}: ${body.slice(0, 200)}`);
    }

    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    } catch (err) {
      throw internal(`Entailment check returned unparseable JSON: ${(err as Error).message}`);
    }

    const raw = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? '';
    const label = VALID_LABELS.find(candidateLabel => candidateLabel === raw);
    if (!label) {
      throw internal(`Entailment check returned an unrecognized label: ${JSON.stringify(raw).slice(0, 100)}`);
    }

    return label;
  } catch (err) {
    if (err instanceof BrainError) {
      throw err;
    }
    throw internal(`Entailment check failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
