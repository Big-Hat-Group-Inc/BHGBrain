import { describe, it, expect } from 'vitest';
import { FixtureEmbeddingProvider, hashToUnitVector } from './fixture-embedding-provider.js';

function magnitude(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
}

describe('hashToUnitVector', () => {
  it('is deterministic: the same text produces the same vector across calls', () => {
    const a = hashToUnitVector('TypeScript generics use extends for constraints', 64);
    const b = hashToUnitVector('TypeScript generics use extends for constraints', 64);
    expect(a).toEqual(b);
  });

  it('produces a unit-length vector for non-empty text', () => {
    const vector = hashToUnitVector('some reasonably long piece of content', 64);
    expect(magnitude(vector)).toBeCloseTo(1, 6);
  });

  it('produces a unit-length vector even for empty text', () => {
    const vector = hashToUnitVector('', 64);
    expect(magnitude(vector)).toBeCloseTo(1, 6);
    expect(vector.some(v => Number.isNaN(v))).toBe(false);
  });

  it('produces different vectors for unrelated text', () => {
    const a = hashToUnitVector('typescript generics and constraints', 128);
    const b = hashToUnitVector('kubernetes resource requests and limits', 128);
    expect(a).not.toEqual(b);
  });
});

describe('FixtureEmbeddingProvider', () => {
  it('embed() is deterministic and normalized', async () => {
    const provider = new FixtureEmbeddingProvider(32);
    const first = await provider.embed('redis cache TTL policy');
    const second = await provider.embed('redis cache TTL policy');
    expect(first).toEqual(second);
    expect(magnitude(first)).toBeCloseTo(1, 6);
    expect(first).toHaveLength(32);
  });

  it('embedBatch() matches embed() called individually, preserving order', async () => {
    const provider = new FixtureEmbeddingProvider(32);
    const texts = ['first piece of text', 'second piece of text', 'third piece of text'];
    const batch = await provider.embedBatch(texts);
    const individual = await Promise.all(texts.map(t => provider.embed(t)));
    expect(batch).toEqual(individual);
  });

  it('exposes a stable provider-qualified identity', () => {
    const provider = new FixtureEmbeddingProvider(64);
    expect(provider.identity).toBe('fixture/hash-shingle-v1@64');
  });

  it('healthCheck always resolves true (no network dependency)', async () => {
    const provider = new FixtureEmbeddingProvider(16);
    await expect(provider.healthCheck()).resolves.toBe(true);
  });
});
