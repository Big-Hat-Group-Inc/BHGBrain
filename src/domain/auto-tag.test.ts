import { describe, it, expect } from 'vitest';
import { extractAutoTags, slugifyAutoTag } from './auto-tag.js';

describe('extractAutoTags: inline code spans', () => {
  it('extracts a slugified tag from a markdown inline-code span', () => {
    const tags = extractAutoTags('Call `useEffect` inside the component.', 10);
    expect(tags).toContain('useeffect');
  });

  it('true negative: a single-character span (below the 2-char floor) is not extracted', () => {
    const tags = extractAutoTags('This is `a` short span.', 10);
    expect(tags).toEqual([]);
  });
});

describe('extractAutoTags: identifier-shaped bare words', () => {
  it('extracts camelCase, PascalCase, snake_case, and dotted-config identifiers', () => {
    const tags = extractAutoTags(
      'Set extractionEnabled and MAX_RETRIES, tune search.ranking.enabled, see GitHubActions.',
      10,
    );
    expect(tags).toContain('extractionenabled');
    expect(tags).toContain('max-retries');
    expect(tags).toContain('search-ranking-enabled');
    expect(tags).toContain('githubactions');
  });

  it('true negative: a version string is not extracted as a dotted identifier', () => {
    const tags = extractAutoTags('Running v1.2.3 now.', 10);
    expect(tags).toEqual([]);
  });

  it('true negative: short words below the 5-char floor are not extracted', () => {
    const tags = extractAutoTags('An eBay and iOS reference.', 10);
    expect(tags).toEqual([]);
  });
});

describe('extractAutoTags: file paths', () => {
  it('extracts a slash-separated, extension-terminated path', () => {
    const tags = extractAutoTags('See src/pipeline/index.ts for details.', 10);
    expect(tags).toContain('src-pipeline-index-ts');
  });

  it('extracts a bare dotted filename with no directory via the allowlist', () => {
    const tags = extractAutoTags('Update package.json with the new dependency.', 10);
    expect(tags).toContain('package-json');
  });
});

describe('extractAutoTags: repo shorthand', () => {
  it('extracts a two-segment owner/repo token with no recognized extension', () => {
    const tags = extractAutoTags('We depend on bhgbrain/core and qdrant/qdrant.', 10);
    expect(tags).toContain('bhgbrain-core');
    expect(tags).toContain('qdrant-qdrant');
  });

  it('true negative: a slash token whose trailing segment has a recognized extension is classified as a file path, not repo shorthand', () => {
    const tags = extractAutoTags('src/pipeline/index.ts', 10);
    expect(tags).toContain('src-pipeline-index-ts');
    // Neither the whole span nor the directory-only prefix should surface
    // as a distinct repo-shorthand-shaped tag.
    expect(tags).not.toContain('pipeline-index');
    expect(tags).not.toContain('src-pipeline');
  });
});

describe('extractAutoTags: @-mentions', () => {
  it('extracts a mention not immediately preceded by a word character', () => {
    const tags = extractAutoTags('cc @jsmith on this.', 10);
    expect(tags).toContain('at-jsmith');
  });

  it('true negative: an email address does not produce a mention tag', () => {
    const tags = extractAutoTags('Contact jsmith@example.com for access.', 10);
    expect(tags).not.toContain('at-jsmith');
    expect(tags).not.toContain('at-example');
  });
});

describe('slugifyAutoTag', () => {
  it.each([
    ['useEffect', 'useeffect'],
    ['@jsmith', 'at-jsmith'],
    ['bhgbrain/core', 'bhgbrain-core'],
    ['src/pipeline/index.ts', 'src-pipeline-index-ts'],
    ['search.ranking.enabled', 'search-ranking-enabled'],
    ['MAX_RETRIES', 'max-retries'],
  ])('slugifies %s to %s', (raw, expected) => {
    expect(slugifyAutoTag(raw)).toBe(expected);
  });

  it('drops candidates that slugify to fewer than 2 characters', () => {
    expect(slugifyAutoTag('--')).toBeNull();
    expect(slugifyAutoTag('.')).toBeNull();
    expect(slugifyAutoTag('a')).toBeNull();
  });

  it('truncates to 100 characters', () => {
    const long = 'a'.repeat(150);
    const slug = slugifyAutoTag(long);
    expect(slug).not.toBeNull();
    expect(slug!.length).toBeLessThanOrEqual(100);
  });

  it('every produced slug matches the TagSchema pattern', () => {
    const samples = ['useEffect', '@jsmith', 'bhgbrain/core', 'src/pipeline/index.ts', 'MAX_RETRIES'];
    for (const raw of samples) {
      const slug = slugifyAutoTag(raw);
      expect(slug).toMatch(/^[a-zA-Z0-9-]+$/);
    }
  });
});

describe('extractAutoTags: dedup and ordering', () => {
  it('deduplicates a repeated token, preserving first-seen order', () => {
    const tags = extractAutoTags(
      'src/pipeline/index.ts is referenced again at src/pipeline/index.ts.',
      10,
    );
    const occurrences = tags.filter(t => t === 'src-pipeline-index-ts');
    expect(occurrences).toHaveLength(1);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('orders results by extraction-category priority, not by text position', () => {
    // The mention appears first in the text, but repo shorthand outranks
    // @-mentions in category priority.
    const tags = extractAutoTags('@jsmith recommends bhgbrain/core', 10);
    expect(tags).toEqual(['bhgbrain-core', 'at-jsmith']);
  });
});

describe('extractAutoTags: maxTags truncation', () => {
  it('truncates to maxTags, keeping the first-seen candidates in priority order', () => {
    const content = 'src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts';
    const tags = extractAutoTags(content, 3);
    expect(tags).toEqual(['src-a-ts', 'src-b-ts', 'src-c-ts']);
  });

  it('returns no tags when maxTags is 0', () => {
    const tags = extractAutoTags('src/pipeline/index.ts and @jsmith and bhgbrain/core', 0);
    expect(tags).toEqual([]);
  });
});
