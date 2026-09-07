// Shared cosine similarity helper. Originally private to `ResourceHandler`
// (`memory://inject/{hint}`'s near-duplicate suppression); extracted here so
// `SearchService`'s MMR reordering (`add-mmr-diversity-reranking`) reuses the
// exact same implementation rather than a second near-identical one.
export function cosineSimilarity(a: number[], b: number[]): number {
  return cosineSimilarityWithNorms(a, b, vectorNorm(a), vectorNorm(b));
}

/**
 * A vector's Euclidean norm (magnitude) — the `sqrt(sum(v_i^2))` half of
 * cosine similarity's denominator. Split out so a caller comparing one
 * vector against many others (`DistillationService`'s O(n^2) pairwise
 * clustering pass — bound-corpus-scale-workflows task 2.2) can compute each
 * candidate's norm once up front instead of paying for it again on every
 * pairwise call `cosineSimilarity` makes.
 */
export function vectorNorm(v: number[]): number {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const vi = v[i]!;
    sumSq += vi * vi;
  }
  return Math.sqrt(sumSq);
}

/**
 * `cosineSimilarity` with both vectors' norms supplied by the caller rather
 * than recomputed here — see `vectorNorm`. Mathematically identical to
 * `cosineSimilarity(a, b)` (same guards, same formula, just the norms
 * hoisted out), so a caller with precomputed norms gets bit-identical
 * output.
 */
export function cosineSimilarityWithNorms(a: number[], b: number[], normA: number, normB: number): number {
  if (a.length !== b.length || a.length === 0) return 0;
  if (normA === 0 || normB === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot / (normA * normB);
}
