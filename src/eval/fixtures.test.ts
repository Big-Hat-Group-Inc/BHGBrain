import { describe, it, expect } from 'vitest';
import { loadFixtures } from './fixtures.js';

describe('loadFixtures', () => {
  it('loads the checked-in corpus and golden-set fixtures without throwing', () => {
    expect(() => loadFixtures()).not.toThrow();
  });

  it('every golden-set expected_corpus_id resolves to a real corpus entry', () => {
    const { corpus, goldenSet } = loadFixtures();
    const corpusIds = new Set(corpus.map(entry => entry.id));
    for (const entry of goldenSet) {
      expect(corpusIds.has(entry.expected_corpus_id)).toBe(true);
    }
  });

  it('the corpus has strictly more entries than the golden set (non-trivial recall@k)', () => {
    const { corpus, goldenSet } = loadFixtures();
    expect(corpus.length).toBeGreaterThan(goldenSet.length);
  });

  it('the golden set has at least 50 entries', () => {
    const { goldenSet } = loadFixtures();
    expect(goldenSet.length).toBeGreaterThanOrEqual(50);
  });

  it('every corpus id is unique', () => {
    const { corpus } = loadFixtures();
    const ids = corpus.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
