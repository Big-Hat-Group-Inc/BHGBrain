import { describe, it, expect } from 'vitest';
import { clusterEpisodicMemories, type ClusterCandidate } from './distillation-cluster.js';

function opts(overrides: Partial<Parameters<typeof clusterEpisodicMemories>[1]> = {}) {
  return {
    similarityThreshold: 0.85,
    minClusterSize: 3,
    maxClusterSize: 20,
    maxClustersPerRun: 10,
    ...overrides,
  };
}

// Simple 2D unit-ish vectors so cosine similarity is easy to reason about.
function v(x: number, y: number): number[] {
  return [x, y];
}

describe('clusterEpisodicMemories', () => {
  it('groups disjoint clusters independently', () => {
    const candidates: ClusterCandidate[] = [
      { id: 'a1', vector: v(1, 0) },
      { id: 'a2', vector: v(0.99, 0.01) },
      { id: 'a3', vector: v(0.98, 0.02) },
      { id: 'b1', vector: v(0, 1) },
      { id: 'b2', vector: v(0.01, 0.99) },
      { id: 'b3', vector: v(0.02, 0.98) },
    ];
    const clusters = clusterEpisodicMemories(candidates, opts());
    expect(clusters).toHaveLength(2);
    const asSets = clusters.map(c => new Set(c));
    expect(asSets.some(s => s.has('a1') && s.has('a2') && s.has('a3'))).toBe(true);
    expect(asSets.some(s => s.has('b1') && s.has('b2') && s.has('b3'))).toBe(true);
  });

  it('keeps a below-threshold pair separate', () => {
    const candidates: ClusterCandidate[] = [
      { id: 'x', vector: v(1, 0) },
      { id: 'y', vector: v(0, 1) },
    ];
    const clusters = clusterEpisodicMemories(candidates, opts({ minClusterSize: 2 }));
    expect(clusters).toHaveLength(0); // each singleton is below minClusterSize
  });

  it('drops a cluster below min_cluster_size', () => {
    const candidates: ClusterCandidate[] = [
      { id: 'p', vector: v(1, 0) },
      { id: 'q', vector: v(0.999, 0.001) },
    ];
    const clusters = clusterEpisodicMemories(candidates, opts({ minClusterSize: 3 }));
    expect(clusters).toHaveLength(0);
  });

  it('splits a cluster above max_cluster_size into deterministic chunks', () => {
    // 5 near-identical vectors, all mutually above threshold -> one component of size 5.
    const candidates: ClusterCandidate[] = ['e', 'd', 'c', 'b', 'a'].map((id, i) => ({
      id,
      vector: v(1, i * 0.0001),
    }));
    const clusters = clusterEpisodicMemories(candidates, opts({ maxClusterSize: 2, minClusterSize: 2 }));
    // 5 members split into chunks of <=2: [2, 2, 1] -> the trailing 1-member
    // chunk is below minClusterSize (2) and dropped, leaving two chunks.
    expect(clusters.every(c => c.length <= 2)).toBe(true);
    const allIds = clusters.flat();
    expect(new Set(allIds).size).toBe(allIds.length); // no id appears twice
    expect(allIds.length).toBe(4); // 2 + 2, the last singleton chunk dropped
  });

  it('truncates deterministically to max_clusters_per_run, largest first', () => {
    const candidates: ClusterCandidate[] = [];
    // Cluster "big": 4 members, cluster "small": 3 members, far apart.
    for (let i = 0; i < 4; i++) candidates.push({ id: `big-${i}`, vector: v(1, i * 0.0001) });
    for (let i = 0; i < 3; i++) candidates.push({ id: `small-${i}`, vector: v(0, 1 + i * 0.0001) });

    const clusters = clusterEpisodicMemories(candidates, opts({ minClusterSize: 3, maxClustersPerRun: 1 }));
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.every(id => id.startsWith('big-'))).toBe(true);
  });
});
