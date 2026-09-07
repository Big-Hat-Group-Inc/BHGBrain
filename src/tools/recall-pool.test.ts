import { describe, it, expect } from 'vitest';
import { computeRecallFetchLimit } from './recall-pool.js';

// strengthen-verification-and-code-boundaries task 3.4: boundary coverage
// for recall's candidate-pool sizing — no ToolContext, no store double, no
// transport. src/tools/index.test.ts's existing recall tests continue to
// cover this through handleRecall itself.
describe('computeRecallFetchLimit', () => {
  const mmrOff = { enabled: false, candidate_pool_multiplier: 3, candidate_pool_cap: 50 };
  const mmrOn = { enabled: true, candidate_pool_multiplier: 3, candidate_pool_cap: 50 };
  const rerankOff = { enabled: false, candidate_pool: 20 };

  it('with MMR and rerank both off, uses limit * 2 capped at 40', () => {
    expect(computeRecallFetchLimit(5, mmrOff, rerankOff)).toBe(10);
    expect(computeRecallFetchLimit(30, mmrOff, rerankOff)).toBe(40);
  });

  it('MMR off boundary: limit * 2 exactly at the 40 cap is unaffected by it', () => {
    expect(computeRecallFetchLimit(20, mmrOff, rerankOff)).toBe(40);
    expect(computeRecallFetchLimit(21, mmrOff, rerankOff)).toBe(40);
  });

  it('with MMR on, uses limit * multiplier capped at candidate_pool_cap', () => {
    expect(computeRecallFetchLimit(5, mmrOn, rerankOff)).toBe(15);
    expect(computeRecallFetchLimit(20, mmrOn, rerankOff)).toBe(50); // 60 -> capped at 50
  });

  it('MMR on boundary: multiplier product exactly at the cap is unaffected by it', () => {
    const mmr = { enabled: true, candidate_pool_multiplier: 2, candidate_pool_cap: 50 };
    expect(computeRecallFetchLimit(25, mmr, rerankOff)).toBe(50);
    expect(computeRecallFetchLimit(26, mmr, rerankOff)).toBe(50);
  });

  it('with rerank on, widens the pool up to candidate_pool (capped at 40) when that exceeds the base pool', () => {
    const rerank = { enabled: true, candidate_pool: 35 };
    // Base (MMR off, limit 2): min(2*2, 40) = 4 — rerank widens it to 35.
    expect(computeRecallFetchLimit(2, mmrOff, rerank)).toBe(35);
  });

  it('rerank never narrows a pool MMR already widened past rerank.candidate_pool', () => {
    const rerank = { enabled: true, candidate_pool: 10 };
    // MMR on, limit 20: base = min(20*3, 50) = 50, far above rerank's 10.
    expect(computeRecallFetchLimit(20, mmrOn, rerank)).toBe(50);
  });

  it('rerank\'s own widening is capped at 40 even when candidate_pool requests more', () => {
    const rerank = { enabled: true, candidate_pool: 50 };
    // Base (MMR off, limit 1): min(1*2, 40) = 2 — rerank's cap is
    // min(50, 40) = 40, so the result is 40, not 50.
    expect(computeRecallFetchLimit(1, mmrOff, rerank)).toBe(40);
  });

  it('rerank off is a no-op regardless of its own candidate_pool value', () => {
    expect(computeRecallFetchLimit(5, mmrOff, { enabled: false, candidate_pool: 999 })).toBe(10);
  });

  it('a limit of 0 with everything off produces a pool of 0', () => {
    expect(computeRecallFetchLimit(0, mmrOff, rerankOff)).toBe(0);
  });

  it('a limit of 0 with rerank on still widens to rerank\'s pool', () => {
    expect(computeRecallFetchLimit(0, mmrOff, { enabled: true, candidate_pool: 12 })).toBe(12);
  });
});
