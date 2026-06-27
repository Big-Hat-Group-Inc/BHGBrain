# Code Audit — OpenSpec proposal `fix-collection-scope-consistency`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `fix-collection-scope-consistency`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM (`.js` import extensions, Node>=20), Zod config, Pino logging, Vitest co-located `.test.ts`, sql.js SQLite + Qdrant
- **Files reviewed:** 7 (`src/search/index.ts`, `src/storage/qdrant.ts`, `src/storage/sqlite.ts`, `src/pipeline/index.ts`, `src/resources/index.ts`, `src/tools/index.ts`, plus co-located test files inspected for coverage)

## Executive summary

The proposal is **unimplemented**. None of the four design decisions or six spec scenarios are reflected in the source, and every item in `tasks.md` remains unchecked. The three defects the proposal targets are all still live in `main`: vector search silently falls back to collection `general` when `collection` is omitted (`qdrant.ts:141`), exact dedup keys on `(namespace, checksum)` ignoring collection (`pipeline/index.ts:110` + `sqlite.ts:496`), and the `collection://{name}` resource truncates a 50-row namespace slice before filtering (`resources/index.ts:235-236`). Two of these are **Security-relevant** (cross-collection result leakage / silent omission) and one is a **Stability/correctness** data-completeness bug. Headline severity counts: 1 High, 2 Medium, 1 Low. Because this is a pre-implementation audit, findings document the existing defects the proposal must fix rather than regressions introduced by it.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| **Req:** Omitted-collection retrieval searches the full namespace (semantic/fulltext/hybrid) | Missing | Vector path still falls back to `general` at `src/storage/qdrant.ts:141` (`const collName = collection ?? 'general'`). Fulltext is namespace-wide (`src/storage/sqlite.ts:560-562`, applies collection filter only when supplied) → semantic vs fulltext scopes diverge exactly as the proposal describes. |
| — Scenario: Semantic search without a collection includes non-general collections | Missing | `src/search/index.ts:71-73` → `qdrant.search(namespace, collection, ...)` → `general` fallback; non-general collections never queried. No fan-out/enumerate logic present. |
| — Scenario: Hybrid search uses same scope for vector and fulltext | Missing | `src/search/index.ts:117` (fulltext, namespace-wide) vs `:121-123` (vector, `general`-scoped) gather from different scopes. |
| **Req:** Exact deduplication respects collection boundaries | Missing | `src/pipeline/index.ts:110` calls `getMemoryByChecksum(input.namespace, checksum)`; helper is `(namespace, checksum)`-scoped at `src/storage/sqlite.ts:496-498`. No `collection` parameter exists. |
| — Scenario: Same checksum in a different collection remains addable | Missing | Same content in collection B returns terminal NOOP against collection A match (`pipeline/index.ts:110-118`). |
| — Scenario: Same checksum in the same collection remains a no-op | Drifted | NOOP still occurs (`pipeline/index.ts:111-118`), but it fires namespace-wide, so the "same collection" guarantee is incidental, not enforced. |
| **Req:** Collection resources return complete, paginated collection-scoped results | Missing | `src/resources/index.ts:235-236` loads `listMemories(namespace, 50)` then filters by collection in memory; no direct query, no pagination/cursor. |
| — Scenario: Collection resource does not truncate before filtering | Missing | `resources/index.ts:235-236` truncates to 50 newest namespace rows before the `collection === path` filter. |
| — Scenario: Collection resource paginates large collections | Missing | Response shape `{ collection, memories }` (`resources/index.ts:237`) has no cursor/pagination contract. |
| **Task 1.1** SQLite checksum-by-`(ns,collection,checksum)` + paginated collection listing | Missing | No such helpers in `src/storage/sqlite.ts` (grep: no `getMemoryByChecksumInCollection`, no paginated `listMemoriesByCollection`). |
| **Task 1.2** Vector helper enumerates namespace collections + merges (no `general` fallback) | Missing | `src/storage/qdrant.ts:130-171` unchanged; no enumerate/merge path. |
| **Task 2.1** Search/recall omitted-collection scope unified across modes | Missing | `src/search/index.ts:56-171` and `src/tools/index.ts:118,150` pass `collection` straight through; no unification. |
| **Task 2.2** Exact dedup + `collection://{name}` respect collection scope w/ pagination | Missing | `pipeline/index.ts:110`, `resources/index.ts:235-236` unchanged. |
| **Task 3.1** Regression tests (omitted-collection semantic/hybrid, cross-collection dedup, resource completeness) | Missing | No matching tests found in `src/*/*.test.ts` (grep for cross-collection / namespace-wide / fan-out returned nothing). |
| **Task 3.2** Run lint/test/build | Not verifiable / Missing | No implementation to verify; no evidence of execution against these changes. |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | High | High | M | Security | `src/storage/qdrant.ts:141` | Omitted-collection semantic/hybrid search silently falls back to `general`, hiding all non-general results |
| 2 | Medium | High | M | Stability | `src/pipeline/index.ts:110`, `src/storage/sqlite.ts:496` | Exact checksum dedup is namespace-scoped; identical content in a different collection is silently dropped to NOOP |
| 3 | Medium | High | M | Stability | `src/resources/index.ts:235` | `collection://{name}` truncates 50 newest namespace rows before filtering; valid older collection members vanish; no pagination |
| 4 | Low | Medium | S | Logging | `src/search/index.ts:125`, `src/storage/qdrant.ts:141` | Scope-narrowing fallbacks (`general`, embedding-unavailable) happen with no log/metric, making the silent-miss defects undebuggable |

## Quick wins

- **Finding 4 (Effort S):** add a Pino debug/warn log and/or a metric counter wherever the search layer narrows or degrades scope (the `?? 'general'` fallback at `qdrant.ts:141` and the silent fulltext-only fallback at `search/index.ts:125-127`). This is independent of the larger fix and immediately makes the silent-miss behavior observable, which also de-risks the eventual implementation.

## Performance

### [Low · Medium · M] Planned fan-out has no concurrency or cap yet — note for implementation — `src/storage/qdrant.ts:130`
**Issue:** The design (Decision 2, Open Questions) calls for enumerate-then-merge across namespace collections when `collection` is omitted. The current `search()` queries exactly one Qdrant collection. When implemented naively (sequential per-collection queries with full `limit*2` fetch each), namespaces with many collections will see latency scale linearly with collection count on a hot read path.
**Why it matters:** `recall`/`search` are the most frequent read operations; an unbounded sequential fan-out can turn a single-collection query into N round-trips.
**Recommendation:** When implementing, query only SQLite-known collections (`listCollections(namespace)` already exists at `sqlite.ts:960`), issue per-collection vector queries concurrently (`Promise.all` with a bounded concurrency), cap per-collection fetch to what the merge needs, and merge only the top candidates for the final limit — exactly as the design's Risks/Mitigation section prescribes.

## Logging & observability

### [Low · Medium · S] Scope-narrowing and degraded-search fallbacks are silent — `src/search/index.ts:125`, `src/storage/qdrant.ts:141`
**Issue:** Two scope-affecting fallbacks emit nothing: (1) `qdrant.ts:141` substitutes `general` when `collection` is undefined, and (2) `search/index.ts:125-127` swallows embedding errors and silently degrades hybrid search to fulltext-only (`catch {}` with only a comment). There is no Pino log, no metric, and in case (2) the error object is discarded entirely.
**Why it matters:** These are precisely the code paths producing the "silent miss" bugs the proposal exists to fix. Without a log line or counter, operators cannot tell that results were narrowed, and the regression tests in Task 3.1 will be the only signal. A swallowed embedding error (case 2) also hides a real provider/circuit-breaker outage.
**Recommendation:** Emit a structured Pino `debug` (scope narrowing) / `warn` (embedding degraded) with `namespace`, `mode`, and chosen scope, and increment a metric (e.g. `search_scope_fallback_total`, `search_embedding_degraded_total`) via the already-injected `MetricsCollector`. Keep the fulltext fallback behavior; just make it observable.

## Stability & reliability

### [Medium · High · M] Exact dedup ignores collection — identical content in another collection collapses to NOOP — `src/pipeline/index.ts:110`, `src/storage/sqlite.ts:496`
**Issue:** `runWrite` performs exact dedup via `getMemoryByChecksum(input.namespace, checksum)` (`pipeline/index.ts:110`), whose SQL is `WHERE namespace = ? AND checksum = ?` (`sqlite.ts:497-498`) — collection is not part of the key. A client storing the same normalized content into collection B, when an identical checksum already exists in collection A of the same namespace, receives a terminal `NOOP` pointing at A's memory (`pipeline/index.ts:111-118`) and the write to B never happens.
**Why it matters:** Silent data loss across collection boundaries. It also creates a read/write asymmetry: near-dedup similarity search is collection-scoped (`pipeline/index.ts:135` passes `input.collection`) while exact dedup is not — the exact mismatch the design calls out (Decision 3).
**Recommendation:** Add a `getMemoryByChecksum(namespace, collection, checksum)` overload/helper keyed on all three columns (an index `idx_memories_checksum` exists at `sqlite.ts:166` but covers only `(namespace, checksum)` — extend it to include `collection`), and pass `input.collection` from `pipeline/index.ts:110`. Cover both spec scenarios (different-collection addable, same-collection NOOP) with regression tests.

### [Medium · High · M] `collection://{name}` truncates before filtering and cannot paginate — `src/resources/index.ts:235`
**Issue:** The resource loads `listMemories(namespace, 50)` (newest-first across the whole namespace) then filters `m.collection === path` in memory (`resources/index.ts:235-236`). If the 50 newest namespace memories belong to other collections, valid older members of the requested collection are silently absent. The response `{ collection, memories }` (`:237`) carries no cursor, so larger collections cannot be paged.
**Why it matters:** Correctness bug — the resource can return an empty or partial list for a collection that demonstrably has members, with no signal of truncation. Behavior degrades as namespace activity grows, which is unbounded.
**Recommendation:** Add a direct paginated SQLite query (`WHERE namespace = ? AND collection = ? AND archived = 0` with the same composite-cursor pattern already used by `listMemories` at `sqlite.ts:508-540`), and return a `PaginatedResult` with a `cursor`, mirroring `memory://list` (`resources/index.ts:73-92`). `countMemoriesInCollection` already exists (`sqlite.ts:541`) for `total_results`.

## Security

### [High · High · M] Omitted-collection semantic/hybrid search silently scopes to `general`, hiding all other collections — `src/storage/qdrant.ts:141`
**Issue:** When `collection` is omitted, `qdrant.search` rewrites it to `general` (`qdrant.ts:141`) and queries only `bhgbrain_<namespace>_general`. `recall` (`tools/index.ts:118`) and `search` semantic/hybrid modes (`search/index.ts:71-73`, `:121-123`) all flow through this path, while the fulltext branch stays namespace-wide (`sqlite.ts:560-562`). The result is two contradictory scopes for the same omitted-collection request, and a hard silent exclusion of every non-`general` collection from vector retrieval.
**Why it matters:** Tagged Security per the audit's cross-collection-leakage emphasis: this is a confidentiality/availability-of-data correctness boundary defect. In the omitted-collection contract the proposal defines (Decision 1: namespace-wide), users expect all collections; today they silently get only `general`, so memories in other collections are unretrievable by semantic/hybrid search with no error. Conversely the inconsistency means hybrid can surface fulltext hits the vector path can never corroborate, producing unstable, mode-dependent results for identical inputs. This is the proposal's headline defect and is fully unaddressed.
**Recommendation:** Implement Decision 2: when `collection` is undefined, enumerate namespace collections via `sqlite.listCollections(namespace)` (`sqlite.ts:960`), query each Qdrant collection, and merge/rerank before hydration — removing the `?? 'general'` fallback. Ensure the fulltext input for hybrid uses the identical namespace-wide scope so both candidate sets agree (spec "Hybrid search uses the same scope" scenario). Add the Task 3.1 regression tests proving non-`general` results are returned.

## Maintainability & code quality

No issues found. The existing code is cleanly layered (tools → search → storage), typed, and consistent with house style; the defects are scope-contract gaps rather than code-quality problems. (When implementing, keep the `general` literal as a single named constant rather than re-introducing magic strings across `qdrant.ts:141`, `sqlite.ts:139/388`, `tools/index.ts:336`.)

## Testing & coverage

### [Medium · High · M] Required regression tests are absent; existing tests would pass with the bugs intact — `src/search/index.test.ts`, `src/pipeline/index.test.ts`, `src/resources/index.test.ts`
**Issue:** Task 3.1 requires regression coverage for (a) omitted-collection semantic/hybrid search returning non-`general` results, (b) cross-collection exact dedup remaining addable, and (c) collection-resource completeness/pagination. A grep across `src/*/*.test.ts` for these scenarios (cross-collection, namespace-wide, fan-out, omitted-collection) returns nothing. The current suite therefore encodes the buggy behavior as acceptable.
**Why it matters:** Without these tests the three defects can persist or silently regress, and there is no executable definition of the new contract. These are also the spec's acceptance criteria — they are the audit trail proving each scenario.
**Recommendation:** Before/with implementation, add the three regression suites mapped 1:1 to the spec scenarios. Each should be written to fail against `main` today (red), so they genuinely guard the fix.

## Dependencies & supply chain

No issues found. The proposal is a pure correctness/scoping change within first-party `src/`; it introduces no new dependencies, and the affected modules (`@qdrant/js-client-rest`, `sql.js`) are unchanged. Confirm no new deps are added during implementation.

## Recommendations (prioritized)

1. **Eliminate the `general` fallback and implement namespace-wide vector fan-out** (Finding 1, High). This is the proposal's core defect and gates the omitted-collection contract for `search` and `recall`. Reuse `listCollections(namespace)`; merge concurrently with a bounded fan-out per the design's mitigation.
2. **Make exact dedup collection-aware** (Finding 2, Medium). Add `(namespace, collection, checksum)` lookup + index, pass `input.collection` at `pipeline/index.ts:110`. Low complexity, prevents silent cross-collection write loss.
3. **Rewrite `collection://{name}` as a direct paginated query** (Finding 3, Medium). Mirror the `memory://list` cursor pattern; use `countMemoriesInCollection` for totals.
4. **Add the three Task 3.1 regression suites** (Testing finding, Medium), written red-against-`main`, mapped to the spec scenarios.
5. **Add observability to scope-narrowing/degraded paths** (Finding 4, Low, Effort S) — a quick win that can land immediately and make both the bug and the fix verifiable in production.
6. After implementation, run `npm run lint && npm test && npm run build` (Task 3.2) and check the `tasks.md` boxes.
