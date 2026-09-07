import { cosineSimilarityWithNorms, vectorNorm } from '../search/similarity.js';

export interface ClusterCandidate {
  id: string;
  vector: number[];
}

export interface ClusterOptions {
  similarityThreshold: number;
  minClusterSize: number;
  maxClusterSize: number;
  maxClustersPerRun: number;
}

// bound-corpus-scale-workflows task 2.2: the outer (`i`) loop runs the O(n)
// event-loop yield check this often — small enough that a large collection's
// O(n^2) comparison pass cedes the event loop regularly (health checks,
// shutdown, other requests stay responsive), large enough that the yield
// overhead itself stays negligible next to the O(n) inner-loop work each
// outer iteration already does.
const YIELD_EVERY_OUTER_ITERATIONS = 200;

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Groups a namespace+collection's T2/T3 episodic memory vectors into
 * clusters of likely-duplicate facts via greedy union-find over cosine
 * similarity, entirely in memory (no per-pair Qdrant round trip — see
 * design.md Decision #3). Not a general clustering library: single-purpose
 * for `DistillationService`.
 *
 * - Two candidates are unioned when their cosine similarity is
 *   `>= similarityThreshold`.
 * - A resulting connected component smaller than `minClusterSize` is
 *   dropped entirely (too weak a signal to distill).
 * - A connected component larger than `maxClusterSize` is deterministically
 *   split into `maxClusterSize`-sized chunks (stable id order) rather than
 *   distilled as one oversized cluster or dropped — every member still gets
 *   a chance to be distilled, just across more than one resulting cluster.
 * - Clusters are returned largest-first (ties broken by first-member id, for
 *   determinism) and truncated to `maxClustersPerRun`.
 *
 * Async (bound-corpus-scale-workflows task 2.2): each candidate's vector
 * norm is computed once up front (`vectorNorm`) rather than recomputed on
 * every pairwise comparison inside the O(n^2) loop below, and the outer loop
 * cedes the event loop every `YIELD_EVERY_OUTER_ITERATIONS` iterations
 * (`yieldToEventLoop`) so a large collection's clustering pass never
 * monopolizes it for the whole comparison. Output is unchanged — the
 * similarity formula and thresholding are identical to the previous
 * synchronous implementation, just with the norms hoisted out and a
 * scheduling yield inserted.
 */
export async function clusterEpisodicMemories(
  candidates: ClusterCandidate[],
  options: ClusterOptions,
): Promise<string[][]> {
  const parent = new Map<string, string>();
  for (const c of candidates) parent.set(c.id, c.id);

  const norms = candidates.map(c => vectorNorm(c.vector));

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i]!;
    const normA = norms[i]!;
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j]!;
      const normB = norms[j]!;
      if (cosineSimilarityWithNorms(a.vector, b.vector, normA, normB) >= options.similarityThreshold) {
        union(a.id, b.id);
      }
    }

    if ((i + 1) % YIELD_EVERY_OUTER_ITERATIONS === 0) {
      await yieldToEventLoop();
    }
  }

  const groups = new Map<string, string[]>();
  for (const c of candidates) {
    const root = find(c.id);
    const arr = groups.get(root) ?? [];
    arr.push(c.id);
    groups.set(root, arr);
  }

  const clusters: string[][] = [];
  for (const ids of groups.values()) {
    ids.sort();
    if (ids.length < options.minClusterSize) continue;

    if (ids.length > options.maxClusterSize) {
      for (let offset = 0; offset < ids.length; offset += options.maxClusterSize) {
        const chunk = ids.slice(offset, offset + options.maxClusterSize);
        if (chunk.length >= options.minClusterSize) {
          clusters.push(chunk);
        }
      }
    } else {
      clusters.push(ids);
    }
  }

  clusters.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0;
  });

  return clusters.slice(0, options.maxClustersPerRun);
}
