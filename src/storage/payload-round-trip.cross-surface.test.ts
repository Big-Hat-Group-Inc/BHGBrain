import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from './sqlite.js';
import { SearchService } from '../search/index.js';
import type { StorageManager } from './index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { BrainConfig } from '../config/index.js';
import type { MetricsCollector } from '../health/metrics.js';

// strengthen-verification-and-code-boundaries task 3.2: one fixture payload,
// pushed through each of the canonical mapper's real consumers — SqliteStore
// hydration (also `repair`'s path, since `handleRepair` calls
// `hydrateBatch`, which calls the same `insertMemoryFromPayloadAtomic` this
// exercises) and SearchService's cross-device fallback — proving they agree
// on every field the two surfaces both expose, not just that each one's own
// unit tests pass in isolation. See src/storage/payload-mapper.test.ts for
// the mapper's own exhaustive field coverage.
describe('Qdrant payload round-trip: hydration and search fallback agree (task 3.2)', () => {
  const ID = '550e8400-e29b-41d4-a716-446655440077';

  // Every field both SqliteStore's hydrated row and SearchService's fallback
  // SearchResult expose — the two surfaces' overlap. Fields recoverable only
  // on one side (checksum, review_due, access_count, ... for hydration;
  // score/semantic_score/fulltext_score, which have no payload source, for
  // search) are covered by payload-mapper.test.ts and each surface's own
  // existing tests instead.
  const fixturePayload = {
    content: 'shared fixture content for round-trip verification',
    summary: 'shared fixture summary',
    type: 'episodic',
    tags: ['round-trip', 'fixture'],
    retention_tier: 'T1',
    expires_at: '2027-01-01T00:00:00.000Z',
    device_id: 'device-round-trip',
    created_at: '2026-01-01T00:00:00.000Z',
    origin: { session_id: 'sess-round-trip', tool: 'claude-code' },
    confidence: 0.8,
  };

  describe('via SqliteStore hydration (hydrateBatch / upsertMemoryFromPayload / repair)', () => {
    let store: SqliteStore;
    let tempDir: string;

    beforeEach(async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-payload-roundtrip-'));
      store = new SqliteStore(tempDir);
      await store.init();
    });

    afterEach(() => {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('recovers the fixture\'s fields into a real row', () => {
      const inserted = store.upsertMemoryFromPayload(ID, fixturePayload);
      expect(inserted).toBe(true);

      const mem = store.getMemoryById(ID);
      expect(mem).toMatchObject({
        content: fixturePayload.content,
        summary: fixturePayload.summary,
        type: fixturePayload.type,
        tags: fixturePayload.tags,
        retention_tier: fixturePayload.retention_tier,
        expires_at: fixturePayload.expires_at,
        device_id: fixturePayload.device_id,
        created_at: fixturePayload.created_at,
        origin: fixturePayload.origin,
        confidence: fixturePayload.confidence,
      });
    });

    it('hydrateBatch (the repair tool\'s own path) recovers the same fields', () => {
      const existingIds = new Set<string>();
      const { hydrated, failures } = store.hydrateBatch([{ id: ID, payload: fixturePayload }], existingIds);

      expect(hydrated).toBe(1);
      expect(failures).toEqual([]);
      expect(store.getMemoryById(ID)).toMatchObject({
        content: fixturePayload.content,
        summary: fixturePayload.summary,
        type: fixturePayload.type,
        tags: fixturePayload.tags,
        retention_tier: fixturePayload.retention_tier,
        expires_at: fixturePayload.expires_at,
        device_id: fixturePayload.device_id,
        created_at: fixturePayload.created_at,
        origin: fixturePayload.origin,
        confidence: fixturePayload.confidence,
      });
    });
  });

  describe('via SearchService cross-device fallback', () => {
    function createSearchService() {
      const storage = {
        sqlite: {
          fullTextSearch: vi.fn(() => []),
          getMemoriesByIds: vi.fn(() => []),
          getMemoryById: vi.fn(() => null),
          recordAccessBatch: vi.fn(),
          touchMemory: vi.fn(),
          scheduleDeferredFlush: vi.fn(),
        },
        qdrant: {
          search: vi.fn(async () => [{ id: ID, score: 0.9, payload: fixturePayload }]),
        },
        logAudit: vi.fn(),
      } as unknown as StorageManager;

      const config = {
        search: {
          hybrid_weights: { semantic: 0.7, fulltext: 0.3 },
          ranking: { enabled: false, w_importance: 0, w_access: 0, access_norm: 1, decay_per_day: { T0: 0, T1: 0, T2: 0, T3: 0 } },
          mmr: { enabled: false, lambda: 0.7, candidate_pool_multiplier: 3, candidate_pool_cap: 50 },
          query_expansion: { enabled: false, max_variants: 1, keyword_stripped: false, llm_paraphrase: { enabled: false, mode: 'paraphrase', variant_count: 1, timeout_ms: 1000 } },
        },
      } as unknown as BrainConfig;

      const embedding = {
        provider: 'openai', model: 'test-model', dimensions: 3, identity: 'openai/test-model@3',
        embed: vi.fn(async () => [1, 2, 3]),
        embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3])),
        healthCheck: vi.fn(async () => true),
      } as EmbeddingProvider;

      const metrics = { incCounter: vi.fn(), recordHistogram: vi.fn() } as unknown as MetricsCollector;
      const logger = { warn: vi.fn() };

      return new SearchService(config, storage, embedding, metrics, logger);
    }

    it('recovers the same fixture\'s fields into a SearchResult when the ranked id misses local storage', async () => {
      const service = createSearchService();

      const results = await service.search('fixture', 'global', undefined, 'semantic', 10);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: ID,
        content: fixturePayload.content,
        summary: fixturePayload.summary,
        type: fixturePayload.type,
        tags: fixturePayload.tags,
        retention_tier: fixturePayload.retention_tier,
        expires_at: fixturePayload.expires_at,
        device_id: fixturePayload.device_id,
        created_at: fixturePayload.created_at,
        origin: fixturePayload.origin,
        confidence: fixturePayload.confidence,
      });
    });
  });
});
