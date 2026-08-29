import type { BrainConfig } from '../config/index.js';
import { generateSummary } from './normalize.js';

/**
 * Small, hardcoded English stopword list — deliberately not exhaustive, just
 * enough to keep the term-frequency scorer from being dominated by function
 * words. No new dependency (see improve-memory-summarization design.md,
 * "Extractive algorithm").
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to',
  'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as', 'into', 'like',
  'through', 'after', 'before', 'between', 'from', 'up', 'down', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'can', 'this', 'that', 'these',
  'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they', 'them', 'his',
  'her', 'their', 'our', 'your', 'my', 'not', 'no', 'so', 'than', 'too',
]);

interface ScoredSentence {
  text: string;
  index: number;
  score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(token => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * Dependency-free extractive summarizer: splits `content` into sentences,
 * scores each by the sum of its tokens' document-wide term frequency
 * normalized by sqrt(token count), and returns the highest-scoring sentence
 * (ties broken by earliest position), truncated to `maxLen` with the same
 * `...` convention as `generateSummary`. See improve-memory-summarization
 * design.md, "Extractive algorithm — TF-scored sentence, length-normalized".
 */
export function extractiveSummary(content: string, maxLen = 120): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return '';

  const rawSentences = trimmed
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (rawSentences.length === 0) return '';
  if (rawSentences.length === 1) {
    return truncate(rawSentences[0]!, maxLen);
  }

  // Document-wide term frequency across every sentence.
  const termFrequency = new Map<string, number>();
  const sentenceTokens: string[][] = [];
  for (const sentence of rawSentences) {
    const tokens = tokenize(sentence);
    sentenceTokens.push(tokens);
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    }
  }

  let best: ScoredSentence | undefined;
  for (const [index, sentence] of rawSentences.entries()) {
    const tokens = sentenceTokens[index]!;
    const rawScore = tokens.reduce((sum, token) => sum + (termFrequency.get(token) ?? 0), 0);
    const score = tokens.length === 0 ? 0 : rawScore / Math.sqrt(tokens.length);
    if (!best || score > best.score) {
      best = { text: sentence, index, score };
    }
  }

  return truncate(best!.text, maxLen);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}

export interface SummarizationProviderLike {
  summarize(content: string, maxLen: number): Promise<string>;
}

interface SummarizeLogger {
  warn: (obj: Record<string, unknown>) => void;
}

/**
 * Picks the summarization tier for a write: `auto_summarize: false` bypasses
 * both quality tiers in favor of literal first-line truncation; otherwise the
 * LLM tier is tried (when enabled and a provider resolves) with any failure
 * falling back to the extractive tier; otherwise the extractive tier runs
 * directly. Never throws — a `remember`/`revert` call must never fail or
 * block because summarization failed (see improve-memory-summarization
 * spec.md).
 */
export async function summarizeContent(
  content: string,
  config: BrainConfig | undefined,
  provider?: SummarizationProviderLike,
  logger?: SummarizeLogger,
): Promise<string> {
  const autoSummarize = config?.auto_summarize ?? true;
  if (!autoSummarize) {
    return generateSummary(content);
  }

  const summarizationEnabled = config?.pipeline.summarization_enabled ?? false;
  if (summarizationEnabled && provider) {
    try {
      return await provider.summarize(content, 120);
    } catch (err) {
      logger?.warn({
        event: 'summarization_degraded',
        error: (err as Error).message,
      });
    }
  }

  return extractiveSummary(content);
}
