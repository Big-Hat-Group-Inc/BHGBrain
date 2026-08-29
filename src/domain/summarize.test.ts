import { describe, it, expect, vi } from 'vitest';
import { extractiveSummary, summarizeContent, type SummarizationProviderLike } from './summarize.js';
import { generateSummary } from './normalize.js';
import type { BrainConfig } from '../config/index.js';

describe('extractiveSummary', () => {
  it('picks the higher-signal sentence over a low-signal first line', () => {
    const content = 'Meeting notes:\nAlice owns the infra repo and handles all deploys.';
    expect(extractiveSummary(content)).toBe('Alice owns the infra repo and handles all deploys');
  });

  it('considers both lines of newline-joined content, unlike generateSummary', () => {
    // Companion to normalize.test.ts's `generateSummary('first\nsecond')` ->
    // 'first' (still first-line-only) — extractiveSummary looks at the whole
    // document instead of discarding everything after the first line.
    expect(extractiveSummary('first\nsecond most informative sentence with substance')).toBe(
      'second most informative sentence with substance',
    );
  });

  it('matches generateSummary for single-sentence/single-line content', () => {
    expect(extractiveSummary('Short line')).toBe(generateSummary('Short line'));

    const long = 'A'.repeat(200);
    expect(extractiveSummary(long)).toBe(generateSummary(long));
  });

  it('returns an empty string for empty or whitespace-only content', () => {
    expect(extractiveSummary('')).toBe('');
    expect(extractiveSummary('   \n  ')).toBe('');
  });

  it('truncates the selected sentence to maxLen with the "..." convention', () => {
    const content = 'Hi.\nAlice owns the infrastructure repository and handles all the daily '
      + 'deployments for the whole engineering organization.';
    const summary = extractiveSummary(content, 20);
    expect(summary.length).toBe(20);
    expect(summary).toContain('...');
  });

  it('truncates single-sentence content to maxLen too', () => {
    const content = 'Alice manages the deploys and repo access for the engineering team.';
    expect(extractiveSummary(content, 10)).toBe(generateSummary(content, 10));
  });
});

describe('summarizeContent', () => {
  const baseConfig = {
    auto_summarize: true,
    pipeline: { summarization_enabled: false },
  } as unknown as BrainConfig;

  const multiSentenceContent = 'Meeting notes:\nAlice owns the infra repo and handles all deploys.';

  it('uses the extractive tier by default (auto_summarize true, no provider)', async () => {
    const result = await summarizeContent(multiSentenceContent, baseConfig);
    expect(result).toBe(extractiveSummary(multiSentenceContent));
  });

  it('routes to literal first-line truncation when auto_summarize is false, even with a healthy LLM provider configured', async () => {
    const config = {
      auto_summarize: false,
      pipeline: { summarization_enabled: true },
    } as unknown as BrainConfig;
    const provider: SummarizationProviderLike = {
      summarize: vi.fn(async () => 'llm summary that should never be used'),
    };

    const result = await summarizeContent(multiSentenceContent, config, provider);

    expect(provider.summarize).not.toHaveBeenCalled();
    expect(result).toBe(generateSummary(multiSentenceContent));
  });

  it('uses the LLM provider when summarization is enabled and it resolves', async () => {
    const config = {
      auto_summarize: true,
      pipeline: { summarization_enabled: true },
    } as unknown as BrainConfig;
    const provider: SummarizationProviderLike = {
      summarize: vi.fn(async () => 'LLM-produced summary'),
    };

    const result = await summarizeContent(multiSentenceContent, config, provider);

    expect(result).toBe('LLM-produced summary');
  });

  it('falls back to the extractive tier when the LLM provider rejects, without throwing', async () => {
    const config = {
      auto_summarize: true,
      pipeline: { summarization_enabled: true },
    } as unknown as BrainConfig;
    const provider: SummarizationProviderLike = {
      summarize: vi.fn(async () => { throw new Error('provider down'); }),
    };
    const logger = { warn: vi.fn() };

    const result = await summarizeContent(multiSentenceContent, config, provider, logger);

    expect(result).toBe(extractiveSummary(multiSentenceContent));
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'summarization_degraded' }));
  });

  it('falls back to the extractive tier when config is undefined', async () => {
    const result = await summarizeContent(multiSentenceContent, undefined);
    expect(result).toBe(extractiveSummary(multiSentenceContent));
  });
});
