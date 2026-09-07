/**
 * Pure hybrid-search rank fusion (Reciprocal Rank Fusion over the semantic
 * and fulltext legs) — extracted out of `SearchService.hybridSearch` so its
 * boundary, tie-break, and empty-input behavior can be tested directly,
 * without a `StorageManager`/embedding double or any transport setup. See
 * strengthen-verification-and-code-boundaries task 3.4.
 */

export interface FusionSemanticItem {
  id: string;
  score: number;
  vector?: number[];
}

// `rank` is the leg's own relevance score (e.g. BM25) — used only to
// *normalize* into `fulltext_score`; RRF itself ranks by this array's
// position (assumed already sorted best-first by the caller), not by this
// field's value. See `fuseRankedResults`'s doc comment.
export interface FusionFulltextItem {
  id: string;
  rank: number;
}

export interface FusedResult {
  id: string;
  score: number;
  semantic_score?: number;
  fulltext_score?: number;
  vector?: number[];
}

/**
 * Min-max normalizes a fulltext leg's raw rank/score field to `[0, 1]`
 * (all-equal input normalizes to a flat `1` rather than dividing by zero).
 * Order-preserving, same length as `items`.
 */
export function normalizeFulltextScores(items: Array<{ rank: number }>): number[] {
  if (items.length === 0) return [];
  const ranks = items.map(item => item.rank);
  const low = Math.min(...ranks);
  const high = Math.max(...ranks);
  if (high === low) return items.map(() => 1);
  return ranks.map(rank => (rank - low) / (high - low));
}

/**
 * Fuses two already-relevance-ordered candidate legs into one ranked list
 * via Reciprocal Rank Fusion: `score(item) = Σ_leg weight_leg / (k +
 * rank_leg(item))` over whichever leg(s) an id appears in (an id present in
 * only one leg is scored from that leg alone — absence from a leg is not a
 * zero rank, it contributes nothing). Ties break lexicographically by id for
 * a fully deterministic order. Returns at most `limit` results, sorted
 * best-first, each carrying both legs' scores (when present) alongside the
 * fused `score` so callers can still inspect per-leg relevance.
 *
 * `fulltextItems`'s RRF rank comes from its position in the array (1-based),
 * not its `.rank` field — callers must pass it pre-sorted best-first, the
 * same contract `SqliteStore.fullTextSearch` already returns. `semanticItems`
 * is likewise assumed pre-sorted (Qdrant's own result order).
 */
export function fuseRankedResults(
  semanticItems: FusionSemanticItem[],
  fulltextItems: FusionFulltextItem[],
  weights: { semantic: number; fulltext: number },
  limit: number,
  rrfK = 60,
): FusedResult[] {
  interface Accumulator {
    id: string;
    semanticRank?: number;
    semanticScore?: number;
    fulltextRank?: number;
    fulltextScore?: number;
    vector?: number[];
  }

  const itemMap = new Map<string, Accumulator>();
  const normalizedFulltextScores = normalizeFulltextScores(fulltextItems);

  semanticItems.forEach((item, idx) => {
    const existing = itemMap.get(item.id) ?? { id: item.id };
    existing.semanticRank = idx + 1;
    existing.semanticScore = item.score;
    existing.vector = item.vector;
    itemMap.set(item.id, existing);
  });

  fulltextItems.forEach((item, idx) => {
    const existing = itemMap.get(item.id) ?? { id: item.id };
    existing.fulltextRank = idx + 1;
    existing.fulltextScore = normalizedFulltextScores[idx]!;
    itemMap.set(item.id, existing);
  });

  const scored = Array.from(itemMap.values()).map(item => {
    const semanticRrf = item.semanticRank ? weights.semantic / (rrfK + item.semanticRank) : 0;
    const fulltextRrf = item.fulltextRank ? weights.fulltext / (rrfK + item.fulltextRank) : 0;
    return {
      id: item.id,
      score: semanticRrf + fulltextRrf,
      semantic_score: item.semanticScore,
      fulltext_score: item.fulltextScore,
      vector: item.vector,
    };
  });

  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));

  return scored.slice(0, limit);
}
