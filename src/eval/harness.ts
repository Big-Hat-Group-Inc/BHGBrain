import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type BrainConfig } from '../config/index.js';
import { SqliteStore, QdrantStore, StorageManager } from '../storage/index.js';
import { SearchService } from '../search/index.js';
import type { SearchResult } from '../domain/types.js';
import { normalizeContent, computeChecksum } from '../domain/normalize.js';
import { FakeQdrantClient, attachFakeQdrantClient } from './fake-qdrant-client.js';
import { FixtureEmbeddingProvider } from './fixture-embedding-provider.js';
import { loadFixtures, type CorpusFixtureEntry, type GoldenSetEntry } from './fixtures.js';

export interface EvalStorage {
  storage: StorageManager;
  config: BrainConfig;
  tempDir: string;
  qdrantClient: FakeQdrantClient;
}

export interface SeededStore extends EvalStorage {
  corpusSize: number;
}

/**
 * Builds a `BrainConfig` through the same public entry point production
 * startup uses (`loadConfig`), pointed at a guaranteed-nonexistent path so it
 * resolves to schema defaults instead of reading this machine's real
 * `config.json` — the harness never wants a developer's actual settings
 * leaking into a "deterministic, offline" eval run. `ConfigSchema` itself is
 * private to `src/config/index.ts` and this proposal's Impact section rules
 * out touching `src/config`, so this is the closest equivalent to
 * design.md's `ConfigSchema.parse({...})` decision that doesn't require
 * exporting it.
 */
function buildEvalConfig(tempDir: string): BrainConfig {
  const config = loadConfig(join(tempDir, 'nonexistent-config.json'));
  config.data_dir = tempDir;
  config.qdrant.mode = 'embedded';
  return config;
}

/**
 * Builds a fresh, empty real `SqliteStore` + real `QdrantStore`-over-
 * `FakeQdrantClient` + `FixtureEmbeddingProvider` trio wrapped in a
 * `StorageManager`, with no memories seeded yet. Each call gets its own
 * temp-dir SQLite file and its own in-memory fake Qdrant collection set, so
 * concurrent/repeated calls never share state. Exported separately from
 * `seedFixtureStore` so callers (tests, in particular) can seed a small
 * synthetic corpus instead of the full fixture set.
 */
export async function createEvalStorage(): Promise<EvalStorage> {
  const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-eval-'));
  const config = buildEvalConfig(tempDir);

  const sqlite = new SqliteStore(tempDir);
  await sqlite.init();

  const qdrant = new QdrantStore(config);
  const qdrantClient = new FakeQdrantClient();
  attachFakeQdrantClient(qdrant as unknown as { client: unknown }, qdrantClient);

  const embedding = new FixtureEmbeddingProvider(config.embedding.dimensions);
  const storage = new StorageManager(sqlite, qdrant, embedding, undefined, config);

  return { storage, config, tempDir, qdrantClient };
}

function isEpermError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EPERM';
}

/**
 * `StorageManager.writeMemory` ends with an unguarded
 * `this.sqlite.flushIfDirty()` (src/storage/index.ts) — by the time it runs,
 * the row is already committed to `SqliteStore`'s in-memory sql.js database
 * and (in the harness) the fake Qdrant client, so a failure here is purely a
 * disk-persistence race, not a lost write. `SqliteStore.flush` only clears
 * its `dirty` flag on success (src/storage/sqlite.ts), so a failed flush
 * leaves the row queued for the *next* successful flush rather than losing
 * it. On Windows, `renameSync` in that flush can transiently fail with
 * `EPERM` (most often antivirus real-time scanning racing the just-written
 * temp file) — reproducible here because seeding the full fixture corpus
 * performs ~175 flush-to-disk renames in a tight sequential loop, far more
 * than any pre-existing test's handful of writes. Retrying the *whole*
 * `writeMemory` call would re-run `insertMemory` against a row that already
 * exists (UNIQUE constraint violation), so this only swallows the flush's
 * `EPERM` — the in-memory state (which is all the harness ever reads from)
 * is already correct. Any other error still propagates. This is scoped to
 * the harness's own seeding loop, not to `StorageManager`/`SqliteStore`
 * themselves — this proposal's Impact section rules out touching
 * `src/storage` — and is a no-op on platforms/environments that never hit
 * the race (e.g. Linux CI, where `rename(2)` has no such lock semantics).
 */
async function writeMemoryTolerateFlushRace(
  storage: StorageManager,
  mem: Parameters<StorageManager['writeMemory']>[0],
  vector: number[],
): Promise<void> {
  try {
    await storage.writeMemory(mem, vector);
  } catch (err) {
    if (!isEpermError(err)) throw err;
  }
}

/**
 * Writes every entry in `corpus` into `storage` through
 * `StorageManager.writeMemory` (not raw SQL) so embedding-identity stamping
 * and collection-compatibility checks run exactly as they do in production
 * (design.md "Seed through StorageManager, not raw SQL"). Timestamps are
 * stamped once for the whole batch (not per-entry) so composite ranking's
 * age-decay term is negligible and uniform across the corpus, keeping
 * relative ranking driven by relevance/importance rather than incidental
 * seed-order timing.
 */
export async function seedCorpusEntries(
  storage: StorageManager,
  corpus: CorpusFixtureEntry[],
): Promise<void> {
  const embedding = storage.embedding;
  const nowIso = new Date().toISOString();
  for (const entry of corpus) {
    const normalized = normalizeContent(entry.content);
    const vector = await embedding.embed(normalized);
    await writeMemoryTolerateFlushRace(
      storage,
      {
        id: entry.id,
        namespace: entry.namespace,
        collection: entry.collection,
        type: entry.type,
        category: entry.category,
        content: normalized,
        summary: entry.summary,
        tags: entry.tags,
        source: entry.source,
        checksum: computeChecksum(normalized),
        importance: entry.importance,
        retention_tier: 'T2',
        expires_at: null,
        decay_eligible: true,
        review_due: null,
        access_count: 0,
        last_operation: 'ADD',
        merged_from: null,
        archived: false,
        vector_synced: true,
        pinned: false,
        device_id: null,
        embedding_model: null,
        created_at: nowIso,
        updated_at: nowIso,
        last_accessed: nowIso,
      },
      vector,
    );
  }
  // Best-effort: persist any still-dirty state left over from a flush that
  // raced and lost (see `writeMemoryTolerateFlushRace`). Not required for
  // correctness within this process — every read the harness performs goes
  // through the same in-memory `SqliteStore` instance, never a disk reload —
  // but keeps the temp-dir file consistent for anyone inspecting it.
  try {
    storage.sqlite.flushIfDirty();
  } catch (err) {
    if (!isEpermError(err)) throw err;
  }
}

/**
 * Closes the SQLite handle (cancelling any pending deferred-flush timer —
 * `SearchService.buildSearchResults` schedules one via
 * `scheduleDeferredFlush()` on every query that records access — so it can
 * never fire after `tempDir` has already been removed) and deletes the temp
 * directory `createEvalStorage`/`seedFixtureStore` created. Callers (tests,
 * `run.ts`) should always tear an eval store down through this rather than a
 * bare `rmSync`, or a deferred flush firing after removal crashes the
 * process with an uncaught `ENOENT` from an unrelated timer callback.
 */
export function teardownEvalStorage(store: EvalStorage): void {
  try {
    store.storage.sqlite.close();
  } catch (err) {
    if (!isEpermError(err)) throw err;
  }
  rmSync(store.tempDir, { recursive: true, force: true });
}

/**
 * Builds a fresh eval store and seeds it with the checked-in fixture corpus
 * (`src/eval/fixtures/corpus.json`).
 */
export async function seedFixtureStore(): Promise<SeededStore> {
  const { corpus } = loadFixtures();
  const base = await createEvalStorage();
  await seedCorpusEntries(base.storage, corpus);
  return { ...base, corpusSize: corpus.length };
}

export interface QueryRankResult {
  query_id: string;
  query: string;
  expected_corpus_id: string;
  // 1-indexed rank within the top-10 results, or null if the expected memory
  // did not appear there at all.
  rank: number | null;
}

/**
 * Runs every golden-set query through the production `SearchService.search`
 * — the same code path `recall`/`search` use — and records the rank (if any,
 * within the top 10) of each query's expected memory. No ranking, fusion, or
 * filtering logic is reimplemented here (spec.md "The harness SHALL evaluate
 * real production retrieval code").
 */
export async function runGoldenSet(
  storage: StorageManager,
  config: BrainConfig,
  goldenSet?: GoldenSetEntry[],
  namespace = 'global',
): Promise<QueryRankResult[]> {
  const entries = goldenSet ?? loadFixtures().goldenSet;
  const search = new SearchService(config, storage, storage.embedding);
  const results: QueryRankResult[] = [];

  for (const entry of entries) {
    const mode = entry.mode ?? 'hybrid';
    const searchResults: SearchResult[] = await search.search(
      entry.query,
      namespace,
      undefined,
      mode,
      10,
      undefined,
      entry.filter,
    );
    const index = searchResults.findIndex(r => r.id === entry.expected_corpus_id);
    results.push({
      query_id: entry.id,
      query: entry.query,
      expected_corpus_id: entry.expected_corpus_id,
      rank: index === -1 ? null : index + 1,
    });
  }

  return results;
}

export interface QueryScore extends QueryRankResult {
  recall_at_1: number;
  recall_at_5: number;
  recall_at_10: number;
  reciprocal_rank: number;
}

export interface AggregateScore {
  count: number;
  recall1: number;
  recall5: number;
  recall10: number;
  mrr10: number;
}

export interface ScoredGoldenSet {
  perQuery: QueryScore[];
  aggregate: AggregateScore;
}

/**
 * Computes recall@1/@5/@10 and MRR@10 per query and in aggregate (spec.md
 * "The harness SHALL compute recall@k and MRR"): a hit at rank `r <= k`
 * scores 1 for recall@k; a miss (rank null or > 10) scores 0 for every k.
 * MRR@10's per-query contribution is `1/r` for a hit within the top 10, else
 * 0. Aggregates are the mean of the per-query scores.
 */
export function scoreResults(perQueryRanks: QueryRankResult[]): ScoredGoldenSet {
  const perQuery: QueryScore[] = perQueryRanks.map(result => {
    const hit = result.rank !== null && result.rank <= 10;
    return {
      ...result,
      recall_at_1: result.rank !== null && result.rank <= 1 ? 1 : 0,
      recall_at_5: result.rank !== null && result.rank <= 5 ? 1 : 0,
      recall_at_10: hit ? 1 : 0,
      reciprocal_rank: hit ? 1 / result.rank! : 0,
    };
  });

  const n = perQuery.length;
  const sum = (values: number[]): number => values.reduce((acc, v) => acc + v, 0);
  const mean = (values: number[]): number => (n === 0 ? 0 : sum(values) / n);

  return {
    perQuery,
    aggregate: {
      count: n,
      recall1: mean(perQuery.map(q => q.recall_at_1)),
      recall5: mean(perQuery.map(q => q.recall_at_5)),
      recall10: mean(perQuery.map(q => q.recall_at_10)),
      mrr10: mean(perQuery.map(q => q.reciprocal_rank)),
    },
  };
}
