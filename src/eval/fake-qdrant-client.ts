import { cosineSimilarity } from '../search/similarity.js';

// Minimal in-memory stand-in for the subset of `@qdrant/js-client-rest`'s
// `QdrantClient` that `QdrantStore` (src/storage/qdrant.ts) actually calls:
// getCollections, getCollection, createCollection, createPayloadIndex,
// upsert, query. Unlike `src/storage/qdrant.test.ts`'s `MockClient` (which
// only records call arguments), `query` here performs a real
// cosine-similarity top-k over in-memory points and `upsert` actually stores
// them, so `QdrantStore`'s own filter-building and fan-out logic runs for
// real (see openspec/changes/add-golden-set-eval-harness/design.md,
// "Real SqliteStore, real QdrantStore-over-fake-client").

export interface FakeQdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

interface FakeQueryResponsePoint {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
  vector?: number[];
}

interface MatchClause {
  key: string;
  match: { value?: unknown; any?: unknown[] };
}

interface RangeClause {
  key: string;
  range: { gte?: unknown; lte?: unknown };
}

interface IsEmptyClause {
  is_empty: { key: string };
}

interface ShouldClause {
  should: FilterClause[];
}

type FilterClause = MatchClause | RangeClause | IsEmptyClause | ShouldClause;

interface QdrantFilterLike {
  must?: FilterClause[];
}

function isShouldClause(clause: FilterClause): clause is ShouldClause {
  return 'should' in clause;
}

function isIsEmptyClause(clause: FilterClause): clause is IsEmptyClause {
  return 'is_empty' in clause;
}

function isMatchClause(clause: FilterClause): clause is MatchClause {
  return 'match' in clause;
}

function meetsRange(value: unknown, range: { gte?: unknown; lte?: unknown }): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') {
    if (typeof range.gte === 'number' && value < range.gte) return false;
    if (typeof range.lte === 'number' && value > range.lte) return false;
    return true;
  }
  if (typeof value === 'string') {
    if (typeof range.gte === 'string' && value < range.gte) return false;
    if (typeof range.lte === 'string' && value > range.lte) return false;
    return true;
  }
  return false;
}

function matchesClause(payload: Record<string, unknown>, clause: FilterClause): boolean {
  if (isShouldClause(clause)) {
    return clause.should.some(sub => matchesClause(payload, sub));
  }
  if (isIsEmptyClause(clause)) {
    const value = payload[clause.is_empty.key];
    return value === null || value === undefined;
  }
  if (isMatchClause(clause)) {
    const value = payload[clause.key];
    if (clause.match.any !== undefined) {
      return Array.isArray(value) && clause.match.any.some(v => value.includes(v));
    }
    return value === clause.match.value;
  }
  return meetsRange(payload[clause.key], clause.range);
}

function notFoundError(name: string): Error & { status: number } {
  const err = new Error(`Collection \`${name}\` doesn't exist!`) as Error & { status: number };
  err.status = 404;
  return err;
}

export class FakeQdrantClient {
  private collections = new Map<string, Map<string, FakeQdrantPoint>>();

  async getCollections(): Promise<{ collections: Array<{ name: string }> }> {
    return { collections: Array.from(this.collections.keys()).map(name => ({ name })) };
  }

  async getCollection(name: string): Promise<{ points_count: number }> {
    const points = this.collections.get(name);
    if (!points) throw notFoundError(name);
    return { points_count: points.size };
  }

  async createCollection(name: string): Promise<{ result: boolean }> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return { result: true };
  }

  async createPayloadIndex(): Promise<{ result: boolean }> {
    // No real index to build — `query` below evaluates filter clauses
    // in-memory against every stored point instead of using an index.
    return { result: true };
  }

  async upsert(
    name: string,
    opts: { points: Array<{ id: string | number; vector: number[]; payload?: Record<string, unknown> }> },
  ): Promise<{ result: { status: string } }> {
    let points = this.collections.get(name);
    if (!points) {
      points = new Map();
      this.collections.set(name, points);
    }
    for (const point of opts.points) {
      const id = String(point.id);
      points.set(id, { id, vector: point.vector, payload: point.payload ?? {} });
    }
    return { result: { status: 'completed' } };
  }

  async query(
    name: string,
    opts: {
      query: number[];
      limit: number;
      filter?: QdrantFilterLike;
      score_threshold?: number;
      with_payload?: boolean;
      with_vector?: boolean;
    },
  ): Promise<{ points: FakeQueryResponsePoint[] }> {
    const points = this.collections.get(name);
    if (!points) throw notFoundError(name);

    const must = opts.filter?.must ?? [];
    const candidates = Array.from(points.values()).filter(point =>
      must.every(clause => matchesClause(point.payload, clause)),
    );

    const scored = candidates
      .map(point => ({ point, score: cosineSimilarity(opts.query, point.vector) }))
      .filter(({ score }) => opts.score_threshold === undefined || score >= opts.score_threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);

    return {
      points: scored.map(({ point, score }) => ({
        id: point.id,
        score,
        ...(opts.with_payload ? { payload: point.payload } : {}),
        ...(opts.with_vector ? { vector: point.vector } : {}),
      })),
    };
  }

  /** Test/debug helper: total point count across every collection. */
  totalPointCount(): number {
    let total = 0;
    for (const points of this.collections.values()) total += points.size;
    return total;
  }
}

/**
 * Swaps a `QdrantStore`'s private, constructor-created real `QdrantClient`
 * for a `FakeQdrantClient` — the same injection technique
 * `src/storage/qdrant.test.ts`'s `createStore` helper already uses. `store`
 * is typed loosely here (not `QdrantStore` itself) so this stays usable from
 * both the harness and its own unit test without importing the class just
 * for the cast target.
 */
export function attachFakeQdrantClient(
  store: { client: unknown },
  client: FakeQdrantClient,
): void {
  store.client = client;
}
