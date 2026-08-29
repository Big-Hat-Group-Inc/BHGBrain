## 1. Constrain the client dependency

- [x] 1.1 Narrow `@qdrant/js-client-rest` in `package.json:51` from `^1.13.0` to a range that matches the client API the adapter targets after the migration in section 2, and refresh `package-lock.json`.
- [x] 1.2 Record the minimum Qdrant server version implied by the chosen client range in `AGENTS.md` / `README.md` prerequisites, so the client and server floors stay stated together.

## 2. Migrate the read path off the removed `search()`

- [x] 2.1 Rewrite the namespace fan-out call at `src/storage/qdrant.ts:170` to `this.client.query(name, { query: vector, filter, score_threshold, limit, with_payload: true })`, keeping the existing `executeWithBreaker` wrapper and the `isNotFoundError` fallback that lets a deleted collection contribute no results.
- [x] 2.2 Update the result mapping at `src/storage/qdrant.ts:183-187` to read from `response.points` instead of a bare array, preserving the `{ id, score, payload }` shape and the top-K merge/sort for multi-collection fan-out.
- [x] 2.3 Rewrite `searchSimilar` at `src/storage/qdrant.ts:204` to `query()` and update its mapping at `:212`.

## 3. Stop swallowing vector-store failures in dedup

- [x] 3.1 Replace the bare `catch { return []; }` in `searchSimilar` (`src/storage/qdrant.ts:203-215`) so only a genuine empty result set returns `[]`; transport, auth, and programming errors propagate or are recorded as an explicit degraded-write signal.
- [x] 3.2 Confirm the write pipeline distinguishes "no near duplicates" from "similarity check unavailable" and does not silently record a novel write when the vector store is unreachable.

## 4. Prevent silent recurrence

- [x] 4.1 Bind the `MockClient` type in `src/storage/qdrant.test.ts:5-8` to the real client surface (e.g. `Pick<QdrantClient, 'getCollections' | 'query'>`) so an upstream method removal fails `npm run lint`.
- [x] 4.2 Add a regression test asserting `search` returns non-empty mapped results for a mocked `{ points: [...] }` response, so a missed `.points` unwrap fails loudly instead of returning empty.
- [x] 4.3 Add a regression test asserting `searchSimilar` propagates (or flags) a client failure rather than returning `[]`.

## 5. Validation

- [x] 5.1 Run `npm run lint`, `npm test`, and `npm run build`.
- [x] 5.2 Verify end to end against a real Qdrant instance: `remember` a memory, confirm the point count in `bhgbrain_{namespace}_{collection}`, then `recall` it in a fresh process and confirm a non-zero `semantic_score` with `degraded: false`. _(2026-08-28: fully verified with a real embedding provider (`OPENAI_API_KEY` supplied by the user) in the same disposable WSL2 Ubuntu 24.04 + Docker + Qdrant 1.19.0 sandbox used for BIG-81/BIG-83. Ran the actual server (`node dist/index.js`, HTTP transport) and called the real MCP tools over `POST /tool/remember` and `POST /tool/recall`, not the storage layer directly. `remember` returned `operation: "ADD"`; `bhgbrain_global_general` point count went 0 -> 1 in Qdrant. Killed the process and started a fresh one against the same data dir, then `recall`'d with a paraphrased query in that fresh process: got the memory back with `semantic_score: 0.65602565` (non-zero, real cosine similarity from a real embedding). Note: `degraded` is a field on the `search` tool's response (`handleSearch`, src/tools/index.ts:224), not on `recall`'s (`handleRecall` returns only `{ results }`, src/tools/index.ts:156-205) — the task's premise conflated the two tools. The substantive signal, a real non-zero `semantic_score` returned by a fresh process against live Qdrant, is confirmed.)_
- [x] 5.3 Verify near-dedup is live again by storing the same content twice and confirming the second write reports a dedup decision rather than a second ADD. _(2026-08-28: fully verified in the same live run — called the real `remember` MCP tool with byte-identical content a second time. Response: `operation: "NOOP"`, same memory `id` as the first write. Qdrant point count confirmed still `1` (no duplicate vector written). This exercises the actual write-pipeline dedup decision end to end, not just the storage-layer similarity score.)_
