## 1. Fake Qdrant transport and fixture embedding provider

- [x] 1.1 Add `src/eval/fake-qdrant-client.ts`: a `FakeQdrantClient` implementing the
  subset of `QdrantClient` that `QdrantStore` calls — `getCollections`,
  `getCollection`, `createCollection`, `createPayloadIndex`, `upsert`, `query`
  (signatures per `src/storage/qdrant.ts:160-175` and the `MockQdrantClient` shape in
  `src/storage/qdrant.test.ts:13-17`). `upsert` stores `{id, vector, payload}` points
  per collection name; `query` performs real cosine-similarity top-k over the stored
  points, honoring the `must` payload filters `QdrantStore.search` builds
  (`src/storage/qdrant.ts:171-175` onward) for `namespace`/`type`/`tags`.
- [x] 1.2 Add `src/eval/fixture-embedding-provider.ts`: an `EmbeddingProvider`
  (`src/embedding/index.ts:25-35`) implementing `embed`/`embedBatch`/`healthCheck` with
  a deterministic character-shingle hash → unit vector of `dimensions` length (no
  network, no API key). Same function embeds corpus text and golden-set queries so
  cosine similarity reflects lexical overlap.
- [x] 1.3 Unit-test both fixtures directly (`src/eval/fake-qdrant-client.test.ts`,
  `src/eval/fixture-embedding-provider.test.ts`): upsert-then-query returns the closest
  point first; a `type`/`tags` filter excludes non-matching points; `embed` is
  deterministic (same text → same vector across calls) and normalized (unit length).

## 2. Golden-set and corpus fixture data

- [x] 2.1 Author `src/eval/fixtures/corpus.json`: ~150–200 seed memories shaped like
  `MemoryRecordWithoutEmbedding` minus store-assigned fields (id/timestamps generated
  by the harness at seed time) — realistic BHGBrain-domain content (coding
  preferences, architecture decisions, project facts) spanning multiple
  `type`/`tags`/`collection` values, including intentional near-duplicates and
  same-tag distractors so retrieval must discriminate, not just recall by tag.
- [x] 2.2 Author `src/eval/fixtures/golden-set.json`: 50 entries of
  `{ id, query, expected_corpus_id, mode?, filter? }` where `expected_corpus_id`
  references an id from `corpus.json` (task 2.1), `mode` defaults to `'hybrid'` (the
  `search` tool's default, `src/domain/schemas.ts:56`) and may be overridden to
  `'semantic'`/`'fulltext'` for entries that specifically target one leg, and `filter`
  optionally carries a `RecallFilter` (`src/domain/types.ts:23-26`) for entries
  exercising filter push-down.
- [x] 2.3 Add a load-time consistency check (used by both the harness and a small
  fixture test) asserting every `expected_corpus_id` exists in `corpus.json` and that
  `corpus.json` has strictly more entries than `golden-set.json` — enforces the
  `golden-set-eval-harness` spec's "seeded corpus" requirement.

## 3. Harness core

- [x] 3.1 Add `src/eval/harness.ts` exporting `seedFixtureStore()`: builds a `BrainConfig`
  via `ConfigSchema.parse({...minimal overrides...})` (`src/config/index.ts:244`, not a
  hand-rolled default object), a temp-dir `SqliteStore` (pattern from
  `src/storage/sqlite.test.ts:12-13`), a `QdrantStore` constructed with the
  `FakeQdrantClient` from task 1.1, and the `FixtureEmbeddingProvider` from task 1.2;
  wraps them in a `StorageManager` (`src/storage/index.ts:57-69`); calls
  `storage.writeMemory(mem, vector)` (`src/storage/index.ts:126-154`) once per
  `corpus.json` entry so embedding-identity stamping and collection-compatibility
  checks run for real.
- [x] 3.2 Add `runGoldenSet(storage, config)` in `src/eval/harness.ts`: constructs a
  `SearchService` (`src/search/index.ts:69-80`) over the seeded `storage`, runs
  `search.search(entry.query, namespace, undefined, entry.mode ?? 'hybrid', 10,
  undefined, entry.filter)` (`src/search/index.ts:82-104`) for every golden-set entry,
  and finds the rank (1-indexed, within top 10) of `entry.expected_corpus_id` in the
  returned `SearchResult[]`.
- [x] 3.3 Add `scoreResults(perQueryRanks)` computing recall@1/@5/@10 and MRR@10 per the
  `golden-set-eval-harness` spec's scoring requirement: hit within `k` → 1 for
  recall@k, `1/rank` for MRR contribution; miss (rank absent or > 10) → 0 for all.
  Return both the per-query breakdown and the aggregate (mean) metrics.
- [x] 3.4 Add `src/eval/harness.test.ts`: seeding populates the expected number of rows
  in both stores; a query with a known, unambiguous expected match ranks first;
  `runGoldenSet` + `scoreResults` on a small synthetic 3-query fixture (not the full
  50) produce hand-verifiable recall/MRR numbers; two consecutive runs against the same
  fixtures produce identical metrics (determinism).

## 4. CI gate (Vitest spec)

- [x] 4.1 Add `src/eval/golden-set.test.ts`: in `beforeAll`, seed the fixture store
  (task 3.1) and run the full `golden-set.json` (task 2.2) through `runGoldenSet` +
  `scoreResults` once; export `FLOOR_RECALL_5` and `FLOOR_MRR_10` as named constants at
  the top of the file with a comment recording the measured baseline at authoring time.
- [x] 4.2 Assert `aggregate.recall5 >= FLOOR_RECALL_5` and `aggregate.mrr10 >=
  FLOOR_MRR_10` in a single `it(...)`; log the full per-query + aggregate report via
  `console.table`/`console.log` inside the test so a floor-trip failure's CI output
  shows which queries regressed, not just the aggregate number.
- [x] 4.3 Confirm no `.github/workflows/ci.yml` changes are needed: `vitest.config.ts`'s
  `include: ['src/**/*.test.ts']` already picks up `src/eval/golden-set.test.ts`, and
  ci.yml's existing `Test` step runs `npm test` (`.github/workflows/ci.yml`, `Test`
  step) — verify by running `npm test` locally and confirming the new spec appears in
  the run output.

## 5. Local report script

- [x] 5.1 Add `src/eval/run.ts`: a small CLI entry point (`tsx`-run, mirroring
  `"dev": "tsx src/index.ts"` in `package.json`) that calls the same
  `seedFixtureStore`/`runGoldenSet`/`scoreResults` core as task 4.1, and prints a
  per-query table (query, expected id, rank or "not found", recall@1/@5/@10 hit/miss)
  followed by the aggregate line; exits with code 1 if any query throws during
  retrieval (store/embedding errors), independent of whether metrics meet their
  floors — no other exit-code coupling to the floors themselves (that's the Vitest
  spec's job, task 4.2).
- [x] 5.2 Add `"eval": "tsx src/eval/run.ts"` to `package.json` `scripts`
  (`package.json:16-26`), alongside the existing `dev`/`test`/`lint` entries.

## 6. Docs

- [x] 6.1 Add the `npm run eval` line to `AGENTS.md`'s "Essential Commands" section
  (`AGENTS.md:19-33`), grouped under a new `# Evaluation` comment near the `Testing`
  block.
- [x] 6.2 No `README.md`/translation changes: this is dev/CI tooling with no MCP
  tool/resource surface or user-facing behavior change (per CLAUDE.md's MCP-surface
  and docs-sync rules, which scope to tool/resource schemas and user-facing behavior).
  No `package.json` `version` bump for the same reason (see
  `openspec/changes/expand-test-coverage`, precedent for test-only changes shipping
  without a version bump).

## 7. Validation

- [x] 7.1 `npm run lint` passes (`tsc --noEmit` + `eslint src`, both cover `src/eval/**`
  per `tsconfig.json:18` and `eslint.config.js:8`) — no `@typescript-eslint/no-explicit-any`
  violations in the new fixtures/harness/test files.
- [x] 7.2 `npm test` passes, including `src/eval/golden-set.test.ts` at or above its
  checked-in floors, and completes within the suite's existing time budget (no real
  network calls, no added external service dependency).
- [x] 7.3 `npm run eval` runs standalone and prints a complete report for all 50
  golden-set entries with no thrown errors.
