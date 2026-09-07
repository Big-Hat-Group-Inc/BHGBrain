/**
 * Pure candidate-pool sizing for `recall` — extracted out of `handleRecall`
 * so its boundary behavior (MMR/rerank on/off, in combination) can be
 * tested directly against plain config objects, without a `ToolContext` or
 * any store/transport double. See strengthen-verification-and-code-
 * boundaries task 3.4.
 */

import type { BrainConfig } from '../config/index.js';

type MmrPoolConfig = Pick<BrainConfig['search']['mmr'], 'enabled' | 'candidate_pool_multiplier' | 'candidate_pool_cap'>;
type RerankPoolConfig = Pick<BrainConfig['search']['rerank'], 'enabled' | 'candidate_pool'>;

/**
 * Over-fetches modestly beyond `limit` so the expired-memory exclusion
 * inside `SearchService.buildSearchResults` cannot starve the caller's
 * limit even once the store already narrows candidates down to matching
 * memories.
 *
 * When MMR is eligible, the pool widens further using its own
 * multiplier/cap so there is genuine diversity headroom beyond `limit`
 * (add-mmr-diversity-reranking); otherwise it is `limit * 2` capped at 40 so
 * a filtered recall never asks the store for an unbounded candidate pool.
 *
 * When reranking is enabled, the pool widens at least up to
 * `rerank.candidate_pool` (capped at 40, the same ceiling the pre-rerank
 * formula uses) so the rerank stage has a meaningful pool to score even for
 * a small `limit`, without ever narrowing whatever MMR already widened it to
 * (add-opt-in-rerank-stage).
 */
export function computeRecallFetchLimit(limit: number, mmr: MmrPoolConfig, rerank: RerankPoolConfig): number {
  const baseFetchLimit = mmr.enabled
    ? Math.min(limit * mmr.candidate_pool_multiplier, mmr.candidate_pool_cap)
    : Math.min(limit * 2, 40);

  return rerank.enabled
    ? Math.max(baseFetchLimit, Math.min(rerank.candidate_pool, 40))
    : baseFetchLimit;
}
