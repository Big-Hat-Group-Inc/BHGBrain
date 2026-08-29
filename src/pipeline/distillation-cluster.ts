import { cosineSimilarity } from '../search/similarity.js';

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
 */
export function clusterEpisodicMemories(
  candidates: ClusterCandidate[],
  options: ClusterOptions,
): string[][] {
  const parent = new Map<string, string>();
  for (const c of candidates) parent.set(c.id, c.id);

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
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (cosineSimilarity(a.vector, b.vector) >= options.similarityThreshold) {
        union(a.id, b.id);
      }
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
