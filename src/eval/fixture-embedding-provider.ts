import type { EmbeddingProvider } from '../embedding/index.js';
import { formatEmbeddingIdentity } from '../embedding/index.js';

// FNV-1a, 32-bit. Deterministic, fast, no dependency — used only to derive a
// stable pseudo-random index/sign per shingle, not for any security purpose.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// Whole-word tokens plus per-token character trigrams, so both exact word
// overlap and partial/typo-tolerant overlap between a query and corpus text
// contribute to cosine similarity (see design.md "Deterministic hash-based
// fixture EmbeddingProvider").
function shingles(text: string): string[] {
  const tokens = tokenize(text);
  const result: string[] = [...tokens];
  for (const token of tokens) {
    if (token.length <= 3) continue;
    for (let i = 0; i <= token.length - 3; i++) {
      result.push(token.slice(i, i + 3));
    }
  }
  return result;
}

/**
 * Deterministic character-shingle hash embedding: the same text always maps
 * to the same unit vector, with no network call and no ML model. Cosine
 * similarity between two such vectors correlates with lexical/shingle
 * overlap, which is enough signal for a golden set written in plain
 * natural-language queries that share vocabulary with their expected match
 * (see design.md Non-Goals — this is not a proxy for real embedding quality).
 */
export function hashToUnitVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const shingle of shingles(text)) {
    const hash = fnv1a(shingle);
    const index = hash % dimensions;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  let magnitude = 0;
  for (const component of vector) magnitude += component * component;
  magnitude = Math.sqrt(magnitude);
  if (magnitude === 0) {
    // Degenerate input (empty/whitespace-only text): return a fixed unit
    // vector rather than dividing by zero, so callers never see NaN.
    vector[0] = 1;
    return vector;
  }
  return vector.map(component => component / magnitude);
}

export class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'fixture';
  readonly model = 'hash-shingle-v1';
  readonly dimensions: number;
  readonly identity: string;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
    this.identity = formatEmbeddingIdentity(this.provider, this.model, this.dimensions);
  }

  async embed(text: string): Promise<number[]> {
    return hashToUnitVector(text, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(text => hashToUnitVector(text, this.dimensions));
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
