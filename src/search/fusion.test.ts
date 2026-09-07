import { describe, it, expect } from 'vitest';
import { fuseRankedResults, normalizeFulltextScores } from './fusion.js';

// strengthen-verification-and-code-boundaries task 3.4: boundary, tie, and
// empty-input coverage for hybrid rank fusion — no StorageManager, no
// embedding provider, no transport. src/search/index.test.ts's existing
// hybrid-mode tests continue to cover this through SearchService itself;
// these exercise the fusion math directly.
describe('fuseRankedResults', () => {
  const WEIGHTS = { semantic: 0.7, fulltext: 0.3 };

  it('returns [] for two empty legs', () => {
    expect(fuseRankedResults([], [], WEIGHTS, 10)).toEqual([]);
  });

  it('scores an id present only in the semantic leg from that leg alone', () => {
    const result = fuseRankedResults([{ id: 'a', score: 0.9 }], [], WEIGHTS, 10);
    expect(result).toEqual([
      { id: 'a', score: WEIGHTS.semantic / 61, semantic_score: 0.9, fulltext_score: undefined, vector: undefined },
    ]);
  });

  it('scores an id present only in the fulltext leg from that leg alone', () => {
    const result = fuseRankedResults([], [{ id: 'a', rank: 5 }], WEIGHTS, 10);
    expect(result).toEqual([
      // Sole fulltext item normalizes to a flat 1 (normalizeFulltextScores'
      // all-equal case), at rank 1.
      { id: 'a', score: WEIGHTS.fulltext / 61, semantic_score: undefined, fulltext_score: 1, vector: undefined },
    ]);
  });

  it('sums both legs\' RRF contributions for an id ranked in each', () => {
    const result = fuseRankedResults(
      [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.1 }],
      [{ id: 'b', rank: 3 }, { id: 'a', rank: 1 }],
      WEIGHTS,
      10,
    );
    const a = result.find(r => r.id === 'a')!;
    // "a" is semantic rank 1 (first in that array) and fulltext rank 2
    // (second in that array — RRF ranks by array position, not the `.rank`
    // field's value) — RRF: semantic/(k+1) + fulltext/(k+2).
    expect(a.score).toBeCloseTo(WEIGHTS.semantic / 61 + WEIGHTS.fulltext / 62, 10);
  });

  it('breaks an exact score tie lexicographically by id, not input order', () => {
    // Two ids with identical single-leg semantic rank 1 is impossible (one
    // array, one rank-1 slot) — the tie instead comes from two disjoint
    // single-leg matches whose RRF scores land exactly equal: both rank 1 in
    // their own leg, with weights chosen so semantic/(k+1) == fulltext/(k+1).
    const equalWeights = { semantic: 0.5, fulltext: 0.5 };
    const result = fuseRankedResults(
      [{ id: 'zeta', score: 0.5 }],
      [{ id: 'alpha', rank: 1 }],
      equalWeights,
      10,
    );
    expect(result[0]!.score).toBeCloseTo(result[1]!.score, 10);
    expect(result.map(r => r.id)).toEqual(['alpha', 'zeta']);
  });

  it('respects limit, keeping only the top-scored results after fusion', () => {
    const semanticItems = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, score: 1 - i * 0.1 }));
    const result = fuseRankedResults(semanticItems, [], WEIGHTS, 2);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.id)).toEqual(['s0', 's1']);
  });

  it('carries the semantic leg\'s vector through when present', () => {
    const result = fuseRankedResults([{ id: 'a', score: 0.9, vector: [1, 2, 3] }], [], WEIGHTS, 10);
    expect(result[0]!.vector).toEqual([1, 2, 3]);
  });

  it('a limit of 0 returns no results even with candidates present', () => {
    expect(fuseRankedResults([{ id: 'a', score: 0.9 }], [], WEIGHTS, 0)).toEqual([]);
  });
});

describe('normalizeFulltextScores', () => {
  it('returns [] for an empty input', () => {
    expect(normalizeFulltextScores([])).toEqual([]);
  });

  it('normalizes a single item to a flat 1 (no range to divide by)', () => {
    expect(normalizeFulltextScores([{ rank: 42 }])).toEqual([1]);
  });

  it('normalizes every equal-rank item to a flat 1, not NaN from a zero range', () => {
    expect(normalizeFulltextScores([{ rank: 7 }, { rank: 7 }, { rank: 7 }])).toEqual([1, 1, 1]);
  });

  it('min-max normalizes a spread of ranks to [0, 1], preserving order', () => {
    expect(normalizeFulltextScores([{ rank: 0 }, { rank: 5 }, { rank: 10 }])).toEqual([0, 0.5, 1]);
  });

  it('handles negative ranks (e.g. negated BM25) the same way', () => {
    expect(normalizeFulltextScores([{ rank: -10 }, { rank: -5 }, { rank: 0 }])).toEqual([0, 0.5, 1]);
  });
});
