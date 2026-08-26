## 1. Constrain the client dependency

- [ ] 1.1 Narrow `@qdrant/js-client-rest` in `package.json:51` from `^1.13.0` to a range that matches the client API the adapter targets after the migration in section 2, and refresh `package-lock.json`.
- [ ] 1.2 Record the minimum Qdrant server version implied by the chosen client range in `AGENTS.md` / `README.md` prerequisites, so the client and server floors stay stated together.

## 2. Migrate the read path off the removed `search()`

- [ ] 2.1 Rewrite the namespace fan-out call at `src/storage/qdrant.ts:170` to `this.client.query(name, { query: vector, filter, score_threshold, limit, with_payload: true })`, keeping the existing `executeWithBreaker` wrapper and the `isNotFoundError` fallback that lets a deleted collection contribute no results.
- [ ] 2.2 Update the result mapping at `src/storage/qdrant.ts:183-187` to read from `response.points` instead of a bare array, preserving the `{ id, score, payload }` shape and the top-K merge/sort for multi-collection fan-out.
- [ ] 2.3 Rewrite `searchSimilar` at `src/storage/qdrant.ts:204` to `query()` and update its mapping at `:212`.

## 3. Stop swallowing vector-store failures in dedup

- [ ] 3.1 Replace the bare `catch { return []; }` in `searchSimilar` (`src/storage/qdrant.ts:203-215`) so only a genuine empty result set returns `[]`; transport, auth, and programming errors propagate or are recorded as an explicit degraded-write signal.
- [ ] 3.2 Confirm the write pipeline distinguishes "no near duplicates" from "similarity check unavailable" and does not silently record a novel write when the vector store is unreachable.

## 4. Prevent silent recurrence

- [ ] 4.1 Bind the `MockClient` type in `src/storage/qdrant.test.ts:5-8` to the real client surface (e.g. `Pick<QdrantClient, 'getCollections' | 'query'>`) so an upstream method removal fails `npm run lint`.
- [ ] 4.2 Add a regression test asserting `search` returns non-empty mapped results for a mocked `{ points: [...] }` response, so a missed `.points` unwrap fails loudly instead of returning empty.
- [ ] 4.3 Add a regression test asserting `searchSimilar` propagates (or flags) a client failure rather than returning `[]`.

## 5. Validation

- [ ] 5.1 Run `npm run lint`, `npm test`, and `npm run build`.
- [ ] 5.2 Verify end to end against a real Qdrant instance: `remember` a memory, confirm the point count in `bhgbrain_{namespace}_{collection}`, then `recall` it in a fresh process and confirm a non-zero `semantic_score` with `degraded: false`.
- [ ] 5.3 Verify near-dedup is live again by storing the same content twice and confirming the second write reports a dedup decision rather than a second ADD.
