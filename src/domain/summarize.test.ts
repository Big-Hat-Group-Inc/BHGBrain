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

// fix-summarizer-url-splitting. A boundary is `.`/`!`/`?` followed by
// whitespace or end-of-input, or a newline — so dots *inside* a token (URLs,
// domains, versions, filenames) no longer sever the sentence around them.
describe('extractiveSummary — intra-token punctuation is not a sentence boundary', () => {
  it('keeps a URL-bearing sentence whole instead of returning a shard of the URL', () => {
    // Observed in production against v1.34.4: this content was persisted with
    // the summary 'limo (ENS domain served via eth' — shard 3 of 4 produced by
    // splitting the domain at its own dots.
    const content =
      "Special Agent K's website is https://specialagentk.eth.limo (ENS domain served via eth.limo)";
    expect(extractiveSummary(content)).toBe(content);
    expect(extractiveSummary(content)).not.toBe('limo (ENS domain served via eth');
  });

  it('does not sever a semantic version or a filename', () => {
    const content = 'Bumped to v1.34.4. The regression was in src/domain/summarize.ts line 46.';
    expect(extractiveSummary(content)).toBe('The regression was in src/domain/summarize.ts line 46');
  });

  it('splits prose around an embedded URL without breaking the URL', () => {
    const content =
      'Deploy runbook. Restart the pod, then verify https://api.example.com/health returns 200.';
    expect(extractiveSummary(content)).toBe(
      'Restart the pod, then verify https://api.example.com/health returns 200',
    );
  });

  it('still treats sentence-final punctuation as a boundary', () => {
    // The whole point of the lookahead is that it fires on real sentence ends.
    expect(extractiveSummary('Alpha beta gamma. Delta epsilon zeta gamma beta alpha.')).toBe(
      'Delta epsilon zeta gamma beta alpha',
    );
  });

  it('produces no trailing empty sentence for content ending in a period', () => {
    // `$` (end-of-input, no `m` flag) makes the final period a boundary, which
    // yields an empty tail that the existing `.filter(s => s.length > 0)` drops.
    expect(extractiveSummary('Ends with a period.')).toBe('Ends with a period');
    expect(extractiveSummary('Ends with a bang!')).toBe('Ends with a bang');
  });

  it('documents the accepted abbreviation limitation (design.md Non-Goals)', () => {
    // `e.g.` still splits at its final dot: 'e.g' survives as its own fragment
    // rather than being shredded to 'e' + 'g'. Improved, not solved — fixing it
    // needs an abbreviation lexicon. Asserted so a later reader recognises this
    // as known rather than as an unnoticed bug.
    const content = 'Uses e.g. an abbreviation mid-sentence. Second sentence here.';
    expect(extractiveSummary(content)).toBe('an abbreviation mid-sentence');
  });
});

// The rows that must NOT move. Without these, the proposal's central claim —
// "byte-identical output for every input that summarises correctly today" — is
// unverified. See fix-summarizer-url-splitting design.md, "verify the no-op
// claim empirically".
describe('extractiveSummary — previously-correct behaviour is unchanged', () => {
  it('still splits on newlines regardless of what follows them', () => {
    // The `\n+` alternation branch: a newline is a boundary unconditionally,
    // not only when followed by more whitespace.
    const content = 'Meeting notes:\nWe decided to move the vector store to Qdrant Cloud.';
    expect(extractiveSummary(content)).toBe('We decided to move the vector store to Qdrant Cloud');
  });

  it('leaves single-sentence and unpunctuated content alone', () => {
    expect(extractiveSummary('One single sentence with no punctuation at all')).toBe(
      'One single sentence with no punctuation at all',
    );
    expect(extractiveSummary('Short line')).toBe(generateSummary('Short line'));
  });

  it('leaves empty and whitespace-only content alone', () => {
    expect(extractiveSummary('')).toBe('');
    expect(extractiveSummary('   \n  ')).toBe('');
  });

  it('handles repeated terminal punctuation as one boundary', () => {
    const content = 'Multiple!! Punctuation?? Marks gamma delta marks.';
    expect(extractiveSummary(content)).toBe('Marks gamma delta marks');
  });

  it('still honours maxLen and the "..." convention on a longer whole sentence', () => {
    // Selected sentences get longer under the new splitter, so truncation
    // fires more often — the 120-char invariant must still hold.
    const content = 'Hi.\nSee https://api.example.com/very/long/path for the full deployment '
      + 'runbook covering every environment we operate.';
    const summary = extractiveSummary(content, 40);
    expect(summary.length).toBe(40);
    expect(summary.endsWith('...')).toBe(true);
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

  // fix-summarizer-url-splitting task 2.6: the segmentation fix is confined to
  // the extractive tier — the tiering above it is untouched. `auto_summarize:
  // false` still routes to generateSummary, which never splits sentences at
  // all, so the URL survives by a different mechanism than the new lookahead.
  it('leaves the tiering untouched: auto_summarize false still routes URL content to literal truncation', async () => {
    const config = { auto_summarize: false, pipeline: {} } as unknown as BrainConfig;
    const urlContent = 'Website: https://specialagentk.eth.limo is the canonical link.';

    const result = await summarizeContent(urlContent, config);

    expect(result).toBe(generateSummary(urlContent));
    expect(result).toContain('https://specialagentk.eth.limo');
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
