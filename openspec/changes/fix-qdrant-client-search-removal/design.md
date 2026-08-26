## Context

`QdrantStore` targets a client API that the declared dependency range no longer guarantees.
`@qdrant/js-client-rest` removed `search()` in `1.19.0`; `package.json:51` allows `^1.13.0`,
which resolves to `1.19.0` today. The adapter calls `search()` in two places and `upsert()`,
`scroll()`, `getCollections()`, `getCollection()` elsewhere - only `search()` was removed.

The failure is asymmetric and quiet. `search()` (`src/storage/qdrant.ts:170`) propagates the
`TypeError` through `executeWithBreaker`, so `recall`/`search` surface a clear `INTERNAL` error.
`searchSimilar()` (`:204`) swallows it in a bare `catch { return []; }`, so the write pipeline
reads "no near duplicates" forever. One symptom is loud, the other is invisible, and both stem
from the same missing method.

The test suite gives no protection. `src/storage/qdrant.test.ts` injects a structurally-typed
`MockClient` over the private `client` field. Because the mock shape is declared locally rather
than derived from `QdrantClient`, it stays green no matter what upstream removes.

## Goals / Non-Goals

**Goals:**
- Restore semantic read and near-dedup behavior on a fresh install.
- Make the dependency range express the client API the code actually requires.
- Ensure a vector-store transport failure is reported as a failure, not as an empty result set.
- Make upstream API removals a type error at lint time rather than a runtime surprise.

**Non-Goals:**
- Changing search semantics, ranking, scoring, or the namespace fan-out logic from
  `fix-collection-scope-consistency`.
- Migrating the Qdrant collection layout or payload schema.
- Adopting other `query`-only capabilities (prefetch, fusion, multi-stage retrieval).
- Standing up a live Qdrant instance in the default `npm test` path.

## Decisions

1. Migrate to `client.query()` rather than pinning below `1.19.0` and staying on `search()`.
- Decision: rewrite both call sites to
  `query(name, { query: vector, filter, score_threshold, limit, with_payload })` and read results
  from `response.points`.
- Rationale: `query` is the supported successor and accepts the same filter, limit,
  `score_threshold`, and `with_payload` arguments this code already passes, so the migration is
  mechanical. Pinning below 1.19.0 only defers the work onto a future security bump.
- Alternative considered: pin `~1.18.0` and keep `search()`. Rejected as the sole fix because it
  leaves the codebase on a removed API and blocks future client upgrades.

2. Narrow the dependency range anyway, as defence in depth.
- Decision: constrain `@qdrant/js-client-rest` to a range matching the client API the adapter
  targets after migration, instead of an open `^` spanning a known breaking removal.
- Rationale: the migration fixes the current break; the narrow range prevents the next silent
  one. Both are needed - this incident is precisely a range that permitted an API removal.
- Alternative considered: leave `^1.13.0` once migrated. Rejected because it would still admit
  any future client internal change under the same caret.

3. Separate "empty" from "failed" in `searchSimilar`.
- Decision: let transport and programming errors propagate to the caller (or be recorded as a
  degraded write signal), and return `[]` only when the store genuinely reports no matches.
- Rationale: the current bare `catch` converted a hard `TypeError` into a business answer. Silent
  dedup loss is a data-quality defect, not a resilience feature.
- Alternative considered: keep swallowing but log a warning. Rejected - dedup would still be
  wrong, just noisier.

4. Type the test double against the real client instead of adding a live-Qdrant test.
- Decision: derive the mock from the real `QdrantClient` type (e.g. a `Pick<>` of the methods the
  adapter uses) so removing a method upstream fails `npm run lint`.
- Rationale: it catches this exact class of break at zero runtime cost and keeps `npm test`
  hermetic. `AGENTS.md` already treats `npm run lint` as a required gate.
- Alternative considered: an integration test against a real Qdrant container. Rejected as the
  primary guard - heavier, and it would not run in the default test path where the regression
  actually needs to be caught.

## Risks / Trade-offs

- `query` returns `{ points }` where `search` returned an array. Missing the unwrap yields
  **empty results rather than an error** - the same silent-failure mode this change exists to
  remove. The spec therefore requires a regression test asserting non-empty results survive the
  adapter boundary, not merely that no error is thrown.
- Type-binding the mock may surface pre-existing shape mismatches in `src/storage/qdrant.test.ts`
  that were previously masked; expect to fix the fixture, not to loosen the type.
- Users already running a broken install need `npm install -g @kkaminsk/bhgbrain` at the fixed
  version; their stored memories are intact and become readable again with no data migration,
  since only the read call changed.
