## Context

`SearchService` (`src/search/index.ts`) is already storage-agnostic at the seam that
matters: it depends on `StorageManager`'s public `sqlite`/`qdrant` fields
(`src/storage/index.ts:57-69`) and an `EmbeddingProvider` (`src/embedding/index.ts:25-35`)
— three constructor-injected interfaces, none of which require a network call by
contract. Every existing test exploits this by mocking all three
(`src/search/index.test.ts:38-77`, `src/storage/qdrant.test.ts:13-30`). That is correct
for unit tests (isolate the formula under test) but means nothing in the suite exercises
the *composition*: does a real query, run through the real fulltext matcher and a
real (fake-backed) vector search, real RRF fusion, and real composite scoring, actually
surface the memory a user would expect?

`.github/workflows/ci.yml` runs exactly two steps — `npm run lint` and `npm test` — on
every push and PR, with no external services (no Qdrant container, no OpenAI network
access). Whatever this harness runs against must work inside that constraint: real
`SqliteStore` is free (sql.js, in-process, already how `src/storage/sqlite.test.ts`
works), but real `QdrantStore` needs a real `QdrantClient`, and real embeddings need
network + an API key CI does not have.

`MemoryRecord.embedding` is not actually persisted in SQLite —
`insertMemory(mem: MemoryRecordWithoutEmbedding)` (`src/storage/sqlite.ts:452`) never
takes a vector; vectors only live in Qdrant, written via
`StorageManager.writeMemory(mem, vector)` → `this.qdrant.upsert(...)`
(`src/storage/index.ts:126-154`). So seeding a store for retrieval requires driving
*both* stores through `StorageManager`, not just inserting rows into SQLite.

## Goals / Non-Goals

Goals:
- Measure recall@k and MRR for the two retrieval paths users actually hit
  (`recall`'s semantic mode, `search`'s hybrid default) against a seeded, realistic
  corpus, using the real `SearchService`/`StorageManager` code — not a reimplementation
  of ranking logic in the eval harness itself.
- Run deterministically, offline, in the existing CI job, in well under a minute.
- Gate CI on a regression (metrics falling below a checked-in floor), not just report
  numbers into a void.
- Give a human a readable per-query report for local debugging (`npm run eval`).

Non-Goals:
- Judging embedding *model* quality (that's an embedding-provider concern, and doing it
  meaningfully requires the real OpenAI/Azure model, which CI cannot call). This harness
  judges BHGBrain's retrieval *pipeline* — filtering, fusion, ranking, the fulltext
  matcher — holding the embedding function fixed and deterministic.
- Historical trend tracking / dashboards for recall@k over time. The Vitest gate catches
  regressions at PR time; a trend store is a plausible future change, not this one.
- Exercising the real `@qdrant/js-client-rest` HTTP client or a real Qdrant server. That
  belongs to a (currently nonexistent) integration-test tier with a live service; this
  harness stays in the same offline, mocked-transport tier as the rest of `npm test`.
- Covering every retrieval-affecting feature exhaustively (e.g. archived-memory recall,
  relevance-conditioned inject). The golden set targets the two default paths; targeted
  scenario coverage for those features remains the job of their own unit tests.

## Decisions

- **Real `SqliteStore`, real `QdrantStore`-over-fake-client.** The fake is a
  `FakeQdrantClient` implementing the subset of `QdrantClient` that `QdrantStore` calls
  (`getCollections`, `getCollection`, `createCollection`, `createPayloadIndex`,
  `upsert`, `query`) — the same shape as `src/storage/qdrant.test.ts`'s
  `MockQdrantClient`, except `query` performs a real cosine-similarity top-k over
  in-memory `{id, vector, payload}` points instead of returning a canned array, and
  `upsert` actually stores the point. This means `QdrantStore.search`'s payload-filter
  construction (`src/storage/qdrant.ts:160-175`, the `RecallFilter` → Qdrant `must`
  translation that `push-down-recall-filters` added) runs for real, not as an assertion
  on call arguments. Rejected alternative: a bespoke object satisfying only
  `StorageManager.qdrant`'s call shape (`.search()`, `.upsert()`) — cheaper to write, but
  it would silently stop exercising `QdrantStore` itself the next time its filter-
  building logic changes, defeating the point of an end-to-end harness.
- **Deterministic hash-based fixture `EmbeddingProvider`.** A pure function maps text to
  a unit vector of the configured `dimensions` via character-shingle hashing (no ML, no
  network), used identically to embed both corpus memories and queries. Cosine
  similarity between two such vectors correlates with lexical/shingle overlap — enough
  for the golden set (written so expected matches share vocabulary with their query,
  same as real short natural-language queries usually do) to produce a meaningful,
  reproducible ranking. This is explicitly not a proxy for real embedding-model quality
  (see Non-Goals) — it is a fast, deterministic stand-in that makes the *retrieval
  pipeline* the thing under test.
- **Seed through `StorageManager`, not raw SQL.** The harness calls
  `storage.writeMemory(mem, vector)` (`src/storage/index.ts:126`) for every corpus
  memory, same as production writes, so embedding-identity stamping
  (`stamp-embedding-provenance`) and collection compatibility checks run unchanged
  rather than being bypassed.
- **Config via `ConfigSchema.parse()`, not a hand-rolled object.** The harness builds its
  `BrainConfig` with `ConfigSchema.parse({ qdrant: { mode: 'embedded' } })` (or whatever
  minimal override `loadConfig` (`src/config/index.ts:235-244`) requires), so
  `search.ranking`, `search.hybrid_weights`, and `retention.tier_ttl` are the *actual*
  shipped defaults, not a second copy that can drift from `src/config/index.ts` the way
  a hand-rolled fixture object would.
- **Corpus size ≈ 150–200 memories for 50 golden pairs.** A 1:1 golden-set-equals-corpus
  setup makes recall@5 trivially high (few distractors to rank above the target). Each
  of the 50 golden queries gets one designated expected-memory id; the remaining
  ~100–150 memories are topically-overlapping distractors (some near-duplicates, some
  same-tag/same-type but different content) so recall@k and MRR carry signal.
- **Metrics: recall@1, recall@5, recall@10, MRR@10**, computed per query (1 if the
  expected id appears in the top-k, 0 otherwise; MRR uses `1/rank` capped at rank 10,
  else 0) and averaged. recall@5 and MRR@10 are the two the Vitest gate asserts a floor
  on — @1 and @10 are reported but informational, giving headroom before a single
  ranking tweak trips the gate on a metric it wasn't really targeting.
- **Gate via a co-located Vitest spec, not a separate CI job.** `src/eval/
  golden-set.test.ts` runs the harness once in a `beforeAll` and asserts
  `expect(aggregate.recall5).toBeGreaterThanOrEqual(FLOOR_RECALL_5)` etc. `npm test`
  (already the CI "Test" step) picks it up with zero `.github/workflows/ci.yml` changes.
  A `.eval.` naming convention is deliberately avoided — Vitest's `include` in
  `vitest.config.ts` is `src/**/*.test.ts`, so anything else needs a second `include`
  entry the file doesn't need.
- **`src/eval/` lives under `src/`, not a top-level `eval/` directory.** `tsconfig.json`
  type-checks and `eslint.config.js` lints `src/**/*` only (`tsconfig.json:18`,
  `eslint.config.js:8`); putting the harness there means `npm run lint` covers it for
  free. The trade-off (accepted, see Risks) is that `tsc`'s `outDir: "dist"` with
  `rootDir: "src"` (`tsconfig.json:6-8`) compiles it into `dist/eval/**`, which ships in
  the published npm package per `package.json`'s `files: ["dist", ...]` — inert weight,
  not wired to any `bin` entry, same category as any other internal module that
  compiles to `dist` without being part of the public surface.
- **`npm run eval` is a thin CLI over the same `src/eval/harness.ts` core** the Vitest
  spec calls, so there is exactly one implementation of "seed store, run queries, score"
  — the test asserts on it, the script pretty-prints it.

## Risks / Trade-offs

- **Fixture embeddings don't predict real-model behavior.** A retrieval bug that only
  manifests with real OpenAI/Azure embeddings (e.g. a dimension-truncation edge case)
  won't show up here. Accepted per Non-Goals: this harness's job is the pipeline around
  the embedding, not the embedding itself.
- **Golden-set authoring is manual and can bake in bias** (queries phrased to make the
  fixture embedding "work"). Mitigated by writing golden queries independently of the
  hash function's internals — plain natural-language phrasing, not engineered n-grams —
  and by keeping the corpus large enough that near-miss distractors are unavoidable.
- **Threshold floors will need occasional deliberate updates** (a genuine ranking
  formula change can legitimately lower recall@5 while improving something else, e.g.
  precision or recency-sensitivity). Floors are a plain exported constant in
  `src/eval/golden-set.test.ts`, changed in the same PR as the retrieval change, same as
  any other test-expectation update — not a separate approval gate.
- **`src/eval/**` shipping in the published package** (see Decisions) is dead weight in
  `dist/` for npm consumers. Accepted as a minor cost against the larger cost of a
  parallel tsconfig/eslint target; revisit if package size ever becomes a real concern.
- **A fake `QdrantClient` can drift from the real one's behavior** (e.g. a Qdrant server
  version bump changes `query` response shape). This is the same risk
  `src/storage/qdrant.test.ts`'s existing `MockQdrantClient` already carries — this
  proposal does not increase it, and fixing it (contract tests against a real Qdrant
  container) is out of scope here.
