import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MemoryType, MemorySource, RecallFilter, SearchMode } from '../domain/types.js';

const CORPUS_PATH = fileURLToPath(new URL('./fixtures/corpus.json', import.meta.url));
const GOLDEN_SET_PATH = fileURLToPath(new URL('./fixtures/golden-set.json', import.meta.url));

/**
 * One seed memory, shaped like `MemoryRecordWithoutEmbedding` minus the
 * fields the store/harness assigns at seed time (timestamps, checksum,
 * access tracking, embedding stamp — see design.md "Seed through
 * StorageManager, not raw SQL"). `id` is author-assigned and stable across
 * runs so `golden-set.json`'s `expected_corpus_id` can reference it directly
 * without any run-to-run remapping.
 */
export interface CorpusFixtureEntry {
  id: string;
  namespace: string;
  collection: string;
  type: MemoryType;
  category: string | null;
  content: string;
  summary: string;
  tags: string[];
  source: MemorySource;
  importance: number;
}

/**
 * One golden-set query. `mode` defaults to `'hybrid'` (the `search` tool's
 * default) when omitted; `filter` optionally exercises filter push-down.
 */
export interface GoldenSetEntry {
  id: string;
  query: string;
  expected_corpus_id: string;
  mode?: SearchMode;
  filter?: RecallFilter;
}

export interface FixtureData {
  corpus: CorpusFixtureEntry[];
  goldenSet: GoldenSetEntry[];
}

function isCorpusFixtureEntry(value: unknown): value is CorpusFixtureEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.namespace === 'string'
    && typeof v.collection === 'string'
    && typeof v.type === 'string'
    && typeof v.content === 'string'
    && typeof v.summary === 'string'
    && Array.isArray(v.tags)
    && typeof v.source === 'string'
    && typeof v.importance === 'number';
}

function isGoldenSetEntry(value: unknown): value is GoldenSetEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.query === 'string' && typeof v.expected_corpus_id === 'string';
}

/**
 * Loads and validates the golden-set fixture: every `expected_corpus_id`
 * must reference a real `corpus.json` entry, and the corpus must strictly
 * outnumber the golden set (see spec.md "A seeded golden-set fixture SHALL
 * exist for retrieval evaluation" — the corpus-size requirement). Throws
 * with an actionable message on any violation rather than letting a stale
 * reference silently score as "not found" during evaluation.
 */
export function loadFixtures(): FixtureData {
  const rawCorpus: unknown = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8'));
  const rawGoldenSet: unknown = JSON.parse(readFileSync(GOLDEN_SET_PATH, 'utf-8'));

  if (!Array.isArray(rawCorpus) || !rawCorpus.every(isCorpusFixtureEntry)) {
    throw new Error(`Malformed corpus fixture at ${CORPUS_PATH}`);
  }
  if (!Array.isArray(rawGoldenSet) || !rawGoldenSet.every(isGoldenSetEntry)) {
    throw new Error(`Malformed golden-set fixture at ${GOLDEN_SET_PATH}`);
  }

  const corpus = rawCorpus;
  const goldenSet = rawGoldenSet;

  const corpusIds = new Set(corpus.map(entry => entry.id));
  const missing = goldenSet.filter(entry => !corpusIds.has(entry.expected_corpus_id));
  if (missing.length > 0) {
    throw new Error(
      `golden-set.json references expected_corpus_id(s) missing from corpus.json: ` +
      missing.map(m => `${m.id} -> ${m.expected_corpus_id}`).join(', '),
    );
  }

  if (corpus.length <= goldenSet.length) {
    throw new Error(
      `corpus.json (${corpus.length} entries) must have strictly more entries than ` +
      `golden-set.json (${goldenSet.length} entries) so recall@k is not trivially satisfied by corpus size alone`,
    );
  }

  return { corpus, goldenSet };
}
