# Code Audit — OpenSpec proposal `optimize-read-path-memory-efficiency`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `optimize-read-path-memory-efficiency`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM (`.js` import extensions, Node ≥20), Zod JSON config with `*_api_key_env` secrets, Pino logging, Vitest co-located `.test.ts`, sql.js SQLite + Qdrant
- **Files reviewed:** 7 (`src/search/index.ts`, `src/resources/index.ts`, `src/storage/sqlite.ts`, `src/tools/index.ts`, `src/tools/schemas.ts`, `src/search/index.test.ts`, `src/resources/index.test.ts`)

## Executive summary

The proposal is **fully implemented and spec-compliant**. Search N+1 hydration was replaced with a single `getMemoriesByIds()` bulk lookup that preserves ranking order in the service layer; read-path access persistence is batched (`recordAccessBatch`) and deferred/coalesced (`scheduleDeferredFlush`, 5s timer) rather than flushing per hit; and auto-inject now assembles content incrementally against a character budget using DB-side `substr` slicing (`getCategoryContentSlice`) instead of loading and concatenating full category bodies. All four spec scenarios and all eight `tasks.md` items have implementing code and tests.

Overall health is good. No Critical/High findings. The findings are Low/Medium-severity refinements: a UTF-16-vs-SQLite character-counting edge in the inject "fully included" check, a per-row (un-batched) UPDATE loop in `recordAccessBatch`, an access-recording asymmetry on the Qdrant-fallback path, and a gap in test coverage for **ranking-order preservation** after bulk hydration (the headline behavioral guarantee of the spec). Headline counts: 0 Critical, 0 High, 2 Medium, 4 Low.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Req: Search hydration must avoid N+1 SQLite lookups | Done | `src/search/index.ts:180` single `getMemoriesByIds(ranked.map(...))`; impl `src/storage/sqlite.ts:1116` IN-clause bulk query |
| Scenario: Hybrid returns ranked IDs → bounded queries + ranking preserved | Done | Bulk fetch then `memoryMap` lookup iterating `ranked` order `src/search/index.ts:181-185`; hybrid RRF sort then slice `src/search/index.ts:160-168` |
| Req: Read-path access recording must remain bounded | Done | Batched updates `src/search/index.ts:238-241` → `recordAccessBatch` `src/storage/sqlite.ts:668`; deferred coalesced flush `src/storage/sqlite.ts:316-323` (5s, single timer) |
| Scenario: Frequent search traffic stays bounded | Done | One `recordAccessBatch` call per request + one `scheduleDeferredFlush`; no per-hit disk write |
| Req: Auto-inject must respect budget while building | Done | Incremental `appendBlock` budget guard `src/resources/index.ts:125-140`; DB-side slice `getCategoryContentSlice(name, remainingForContent)` `src/resources/index.ts:160` / `src/storage/sqlite.ts:1154` |
| Scenario: Large category bodies exceed budget → truncate incrementally, no full concat | Done | Per-category remaining-budget check and break `src/resources/index.ts:145-168`; only `substr(content,1,?)` fetched, never full body |
| Req: Auto-inject must preserve truncation semantics | Done | `truncated` flag set on every over-budget path `src/resources/index.ts:138,148,156,164,190`; returned in payload `:192-198` |
| Scenario: Content exceeds budget → marked truncated + fits max size | Done | `appendBlock` caps at `maxChars` `src/resources/index.ts:136-137`; test asserts `content.length <= 24 && truncated` `src/resources/index.test.ts:107-108` |
| Task 1.1 Bulk hydration API | Done | `getMemoriesByIds` `src/storage/sqlite.ts:1116` |
| Task 1.2 Refactor semantic/fulltext/hybrid to avoid per-hit lookups | Done | All three funnel into `buildSearchResults` which bulk-hydrates `src/search/index.ts:78,95,162,174` |
| Task 1.3 Bound access-metadata persistence | Done | `recordAccessBatch` + `scheduleDeferredFlush` `src/search/index.ts:238-241` |
| Task 2.1 Budget-honoring inject assembly | Done | `buildInjectPayload` incremental `appendBlock` `src/resources/index.ts:120-199` |
| Task 2.2 Avoid loading/concatenating unfittable category content | Done | `getCategoryContentSlice` requests only remaining budget `src/resources/index.ts:160` |
| Task 3.1 Tests for ordered bulk hydration | Partial | `src/search/index.test.ts:91-95` asserts `getMemoriesByIds` is *called*, but not that output **order matches ranking** (the spec's "preserves ranking order" guarantee is unasserted) |
| Task 3.2 Tests for large-category inject payload + truncation metadata | Done | `src/resources/index.test.ts:80-109` |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | Medium | High | S | Testing | `src/search/index.test.ts:91-95` | Bulk-hydration test never asserts ranking-order preservation (the core spec guarantee) |
| 2 | Medium | Medium | S | Maintainability/Stability | `src/resources/index.ts:161` | `fullyIncluded` compares JS UTF-16 `.length` to SQLite `LENGTH()` char count; multibyte/astral content can misclassify truncation |
| 3 | Low | High | S | Performance | `src/storage/sqlite.ts:672-689` | `recordAccessBatch` runs N separate `db.run` UPDATEs (re-parsed each iteration) instead of one reused prepared statement / transaction |
| 4 | Low | High | M | Performance/Maintainability | `src/search/index.ts:189-209` | Qdrant-miss fallback path skips access recording, creating count asymmetry vs SQLite hits (non-determinism noted but undocumented) |
| 5 | Low | Medium | S | Logging | `src/search/index.ts:125-127` | Embedding failure in hybrid search is silently swallowed (empty `catch`), no debug/warn log — degraded-mode fallback is invisible |
| 6 | Low | Low | S | Performance | `src/search/index.ts:147-158` | RRF `scored` map spreads each item (`...item`) before sort; minor transient allocation on hot path |

## Quick wins

- Finding 1: add an assertion that `buildSearchResults` output order equals the ranked-input order (and survives a `getMemoriesByIds` that returns rows in a different order). Small, closes the only Partial spec item.
- Finding 3: wrap the `recordAccessBatch` loop in a single `prepare()`/reuse or transaction.
- Finding 5: add a `logger.debug` in the hybrid embedding `catch` so fulltext-only fallback is observable.

## Performance

### [Low · High · S] `recordAccessBatch` re-parses SQL per row instead of reusing a prepared statement — `src/storage/sqlite.ts:672-689`
**Issue:** The batch loop calls `this.db.run(\`UPDATE memories SET ${sets.join(', ')} WHERE id = ?\`, params)` once per update. `db.run` prepares and frees a statement on every call, and the SQL string is rebuilt per row. With `limit*2` capped at 100 (`src/tools/schemas.ts:62` max 50 → hybrid `limit*2`), this is ≤100 parses per search — bounded, but unnecessary churn on the hottest read path.
**Why it matters:** The whole point of the proposal is reducing per-hit overhead; this batches the *flush* but not the *statement preparation*. Variable `sets` shape differs per row (optional `expires_at`/`retention_tier`/`review_due`), so a naive single prepared statement isn't a drop-in, but grouping rows by their SET-shape or always binding all columns would allow statement reuse.
**Recommendation:** Either always update the full column set (binding unchanged values) to use one reusable prepared statement, or wrap the loop so the common case (access_count + last_accessed only) reuses a single prepared statement.

### [Low · Low · S] RRF fusion spreads each item before sorting — `src/search/index.ts:147-158`
**Issue:** `Array.from(itemMap.values()).map(item => ({ ...item, rrfScore }))` allocates a new object per candidate (up to `limit*2` per side) purely to attach `rrfScore`.
**Why it matters:** Minor heap churn on the search hot path the proposal targets; candidate count is bounded (≤100) so impact is small.
**Recommendation:** Mutate `RankedItem` in place (add an optional `rrfScore` field) or compute score inline in the sort comparator to avoid the intermediate copy. Low priority.

### [Low · High · M] Qdrant-fallback hits bypass access recording — `src/search/index.ts:189-209`
**Issue:** When a ranked ID misses SQLite and is served from the Qdrant payload (cross-device memory), the branch `continue`s before `accessUpdates.push(...)` (which only runs at `:219` for SQLite-hydrated rows). Those results are returned to the user but never have access metadata recorded.
**Why it matters:** Not a regression introduced by this change (fallback rows have no local SQLite row to update), and the spec only requires access recording to be *bounded*, not exhaustive — so this is compliant. But it is an undocumented behavioral asymmetry in access counts that could surprise retention/promotion logic for cross-device memories.
**Recommendation:** Document the intentional skip with a short comment, or (larger) reconcile via the upsert path. No spec violation; informational.

## Logging & observability

### [Low · Medium · S] Silent swallow of embedding failure in hybrid search — `src/search/index.ts:125-127`
**Issue:** `catch { /* Embedding unavailable: fall back to fulltext only */ }` discards the error with no log. Semantic search by contrast surfaces a typed error (`:65-66`, `:74-76`).
**Why it matters:** When the embedding provider degrades, hybrid search silently becomes fulltext-only with no signal in logs or metrics. Operators cannot distinguish "no semantic matches" from "embedding provider down." The codebase uses Pino structured logging elsewhere; this hot path has none here.
**Recommendation:** Add `this.logger?.debug({ err }, 'hybrid search: embedding unavailable, falling back to fulltext')` and/or a `metrics.increment('search_embedding_fallback')` counter.

## Stability & reliability

### [Medium · Medium · S] `fullyIncluded` mixes UTF-16 length with SQLite character length — `src/resources/index.ts:161`
**Issue:** `const fullyIncluded = content.length >= cat.content_length;` compares the JS string's UTF-16 code-unit count (`content.length`, from `substr(content,1,?)` returned over the JS bridge) against `cat.content_length`, which is `LENGTH(content)` in SQLite (`src/storage/sqlite.ts:1138`). SQLite `LENGTH()` on TEXT counts **characters**, and `substr` is **character**-based, whereas JS `.length` counts UTF-16 code units. For category bodies containing astral-plane characters (emoji, some CJK extensions), `content.length` can exceed the character count, so `fullyIncluded` may report `true` when content was actually truncated (or vice versa).
**Why it matters:** This drives the `truncated` flag and the early `break` (`:163-166`). A wrong `fullyIncluded` could mark a payload as complete when category content was cut, or continue appending past intent. The spec requires truncation to be reported accurately. ASCII content (the common case) is unaffected, hence Medium confidence.
**Recommendation:** Make both sides consistent — compare `content.length` against the byte/code-unit length the slice was requested with, or have `getCategoryContentSlice` also return the underlying character length so the comparison uses the same unit. Add a test with multibyte category content.

## Security

No issues found. The IN-clause in `getMemoriesByIds` (`src/storage/sqlite.ts:1118-1122`) uses parameterized placeholders (no string interpolation of IDs). The slice path uses bound parameters. Search `limit` is Zod-bounded to ≤50 (`src/tools/schemas.ts:33,62`), so the IN-clause never approaches sql.js's `SQLITE_MAX_VARIABLE_NUMBER` — no unbounded-load or injection exposure introduced by this change.

## Maintainability & code quality

### [Low · High · S] Inject content-size accounting uses magic offsets — `src/resources/index.ts:154,179`
**Issue:** `remainingForContent = maxChars - totalChars - 2` (the `2` reserves the trailing `\n\n`) and `mem.content.length + 50 <= remaining` (the `50` is an unexplained slack for the `- [type] ` wrapper) are bare literals.
**Why it matters:** These offsets silently couple to the exact format strings around them (`${content}\n\n`, `- [${mem.type}] ${mem.content}\n`). A future format tweak can desync the reservation and cause off-by-N truncation. Functionally correct today.
**Recommendation:** Name the constants (e.g. `CATEGORY_SEPARATOR_LEN = 2`, `MEMORY_WRAPPER_SLACK = 50`) or derive them from the actual wrapper strings.

## Testing & coverage

### [Medium · High · S] Bulk-hydration ordering guarantee is untested — `src/search/index.test.ts:91-95`
**Issue:** The test "hydrates ranked results in bulk" only asserts `getMemoriesByIds` was *called with* `['mem-1']`. The spec's load-bearing guarantee — "the final response preserves the original ranking order" after bulk fetch — is never exercised. The mock `getMemoriesByIds` (`:42`) returns rows in input order, so even a buggy implementation that trusted SQL row order (which an `IN (...)` query does **not** guarantee to match input order) would pass.
**Why it matters:** The design's stated risk is exactly "bulk hydration requires order restoration after SQL fetch" (`design.md:29`). The mitigation (service-layer `memoryMap` re-ordering, `src/search/index.ts:181-185`) is correct, but a regression that reordered results would not be caught by the current test. This is the one Partial item in spec compliance.
**Recommendation:** Add a test where the ranked input is `['mem-3','mem-1','mem-2']` and `getMemoriesByIds` returns them in a *different* order (e.g. ascending id), then assert the `SearchResult[]` order matches the ranked input. Also add a coverage case for the Qdrant-fallback branch (`src/search/index.ts:189-209`), currently untested.

## Dependencies & supply chain

No issues found. This change introduces no new dependencies; it uses existing sql.js APIs (`db.prepare`/`substr`/`LENGTH`) and in-repo abstractions. No version-range or transitive-dependency impact.

## Recommendations (prioritized)

1. **Add the ranking-order assertion test** (Finding 1) — closes the only Partial spec item and guards the design's explicitly-called-out risk. (S)
2. **Fix the UTF-16 vs SQLite-length comparison** in `fullyIncluded` and add a multibyte inject test (Finding 2) — only place truncation accuracy can drift. (S)
3. **Reuse a prepared statement / transaction in `recordAccessBatch`** (Finding 3) — completes the per-hit-overhead reduction the proposal set out to achieve. (S)
4. **Log/meter the hybrid embedding fallback** (Finding 5) — restores observability for degraded semantic search. (S)
5. Name the inject magic offsets (Maintainability) and, optionally, document the Qdrant-fallback access-recording skip (Finding 4). (S)
6. Optionally drop the RRF object-spread for in-place scoring (Finding 6) — micro-optimization, lowest priority. (S)
