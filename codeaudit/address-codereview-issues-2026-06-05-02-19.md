# Code Audit — OpenSpec proposal `address-codereview-issues`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `address-codereview-issues`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 14

## Executive summary

The proposal converts a backlog of code-review findings into seven capability specs covering read-path persistence, cross-store atomicity, durable mutation acknowledgement, fail-closed HTTP auth, MCP structured contracts, degraded embedding/health, and search/observability safety. All 19 tasks are checked done in `tasks.md`, and the implementation broadly delivers the contracts: read paths now batch access metadata with a deferred flush (`src/search/index.ts:238`), cross-store updates roll back on Qdrant failure (`src/storage/index.ts:93`), category mutations flush synchronously (`src/tools/index.ts:250`), fail-closed startup checks exist (`src/transport/middleware.ts:141`), MCP resource templates are exposed (`src/index.ts:125`), a `DegradedEmbeddingProvider` plus cached health check are present (`src/embedding/index.ts:106`, `src/health/index.ts:81`), metrics use a bounded circular buffer (`src/health/metrics.ts:21`), and DB/backup writes go through `atomicWriteFileSync` (`src/storage/sqlite.ts:1378`).

Most requirements are **Done**. The main gaps are: (1) the degraded-embedding startup path does **not** emit the high-visibility log the spec/design imply (silent degradation, contradicting design Decision 3); (2) the MCP "structured content" requirement is satisfied only as JSON-in-text, not the MCP `structuredContent` field, which is a partial/drifted reading of the spec; (3) no test asserts atomic-replace write semantics (task 5.6); and (4) one genuine security weakness outside the strict spec scope — the bearer-token comparison is not constant-time. No Critical issues found. Highest severity is Medium.

## Spec compliance

| Requirement / Task | Status | Evidence |
|---|---|---|
| **read-path-persistence-efficiency**: No synchronous full-db flush on read | Done | `src/search/index.ts:238-241` batches via `recordAccessBatch` + `scheduleDeferredFlush`; `src/resources/index.ts:65-66` uses `touchMemory`+deferred flush; no `flush()`/`flushIfDirty()` on read path |
| **read-path-persistence-efficiency**: Access-metadata persistence batched/deferred | Done | `recordAccessBatch` + `scheduleDeferredFlush` (`src/storage/sqlite.ts:316`, debounced 5s) |
| **cross-store-update-atomicity**: Updates cross-store consistent; rollback on Qdrant fail | Done | `src/storage/index.ts:79-99` rolls back SQLite fields + throws on Qdrant failure |
| **cross-store-update-atomicity**: Partial failure observable | Done | Throws `internal(...)` with dependency context (`src/storage/index.ts:97`) |
| **durable-mutation-acknowledgement**: category.set/delete durable before success | Done | `src/tools/index.ts:250,258` call `flushIfDirty()` before returning |
| **fail-closed-http-auth**: External binding without token fails startup | Done | `validateExternalAuthBinding` throws (`src/transport/middleware.ts:151-157`), invoked at `src/transport/http.ts:22` |
| **fail-closed-http-auth**: Unauthenticated mode explicit opt-in + warning | Done | `allow_unauthenticated_http` flag (`src/config/index.ts:136`); warning at `src/transport/middleware.ts:160` |
| **mcp-structured-contracts**: Structured machine-readable success payload | Partial/Drifted | `src/index.ts:111` returns JSON serialized into a `text` content block, not the MCP `structuredContent` field; "without requiring JSON parsing from plain text" not literally met |
| **mcp-structured-contracts**: Errors set `isError` | Done | `src/index.ts:108-112` sets `isError: true` for error envelopes |
| **mcp-structured-contracts**: Resource templates exposed | Done | `MCP_RESOURCE_TEMPLATES` + `ListResourceTemplatesRequestSchema` handler (`src/resources/index.ts:251`, `src/index.ts:125`) |
| **degraded-embedding-and-health-semantics**: Degraded startup, request-time errors | Partial | Starts degraded (`src/embedding/index.ts:144`), request-time errors thrown (`src/embedding/index.ts:117`); but no startup warning log (design Decision 3 / fail-safe visibility) |
| **degraded-embedding-and-health-semantics**: Health avoids per-probe embedding calls | Done | 30s cache + degraded short-circuit (`src/health/index.ts:83-103`) |
| **search-resource-consistency**: Collection scoping in fulltext/hybrid | Done | `fullTextSearch(..., collection)` joins on `m.collection` (`src/storage/sqlite.ts:559-563`); search passes collection (`src/search/index.ts:94,117`) |
| **search-resource-consistency**: Stable composite cursor pagination | Done | `created_at|id` tie-breaker in `listMemories` (`src/storage/sqlite.ts:511-523`) and cursor emission (`src/resources/index.ts:83`) |
| **search-resource-consistency**: Dependency failures surfaced (semantic) | Done | `semanticSearch` throws `internal`/`embeddingUnavailable` (`src/search/index.ts:65-76`) |
| **search-resource-consistency**: Bounded metrics + atomic file writes | Done | `BoundedBuffer` capacity 1000 (`src/health/metrics.ts:53`); `atomicWriteFileSync` (`src/storage/sqlite.ts:1378`, `src/backup/index.ts:48,104`) |
| Task 1.3 tests (no read flush, cross-store failure) | Done | `src/storage/index.test.ts:110-148` (rollback/drift cases) |
| Task 2.4 tests (durability, auth startup) | Done | `src/transport/middleware.test.ts`, `src/transport/http.test.ts` cover external-auth policy |
| Task 3.3 tests (structured outputs, template discovery) | Partial | `src/resources/index.test.ts` covers templates; no test asserts MCP `structuredContent` (consistent with the JSON-in-text impl) |
| Task 4.3 tests (degraded startup, low-cost probe) | Done | `src/embedding/index.test.ts`, `src/health/index.test.ts` reference degraded mode |
| Task 5.6 tests (scoping, pagination, dependency, **atomic write**) | Partial | Scoping/pagination/dependency covered; no test asserts atomic-replace/`.tmp`+rename write safety |
| Task 6.1 / 6.2 docs | Not verified (out of code scope) | Docs in `README.md`/`AGENTS.md` not audited as source; flagged for manual check |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
|---|---|---|---|---|---|---|
| 1 | Medium | High | S | Security | `src/transport/middleware.ts:34` | Bearer token compared with `!==` (not constant-time) |
| 2 | Medium | High | S | Logging & observability | `src/index.ts:59` | Degraded embedding startup is silent; no warning log |
| 3 | Low | Med | M | Maintainability | `src/index.ts:111` | "Structured content" delivered as JSON-in-text, not MCP `structuredContent` |
| 4 | Low | High | S | Testing | `src/storage/sqlite.ts:1378` | No test asserts atomic-replace write semantics (task 5.6) |
| 5 | Low | High | S | Stability & reliability | `src/storage/index.ts:27-43` | ADD-path Qdrant failure persists SQLite (drift model), not rollback like UPDATE |
| 6 | Low | Med | S | Stability & reliability | `src/resources/index.ts:234-237` | `collection://{name}` reads only first 50 memories then filters; silent truncation |
| 7 | Low | Low | S | Performance | `src/storage/sqlite.ts:556` | Fulltext uses `LIKE '%term%'` (non-sargable full scan), not the FTS table |

## Quick wins

- Switch bearer-token comparison to `crypto.timingSafeEqual` (finding 1, ~5 lines).
- Add a `logger.warn({ event: 'embedding_degraded' })` when `createEmbeddingProvider` returns the degraded provider (finding 2).
- Add a single Vitest assertion that a `.tmp` file is written then renamed (or that an interrupted write leaves the original intact) to close task 5.6 (finding 4).

## Performance

### [Low · Low · S] Fulltext search uses non-sargable LIKE scans — `src/storage/sqlite.ts:556`
**Issue:** `fullTextSearch` builds `LOWER(f.content) LIKE '%term%'` predicates against the `memories_fts` table, which is a plain table (`src/storage/sqlite.ts:177`), not an FTS5 virtual table. Each query is a full scan with no index usable for leading-wildcard LIKE.
**Why it matters:** The read-path-efficiency spec targets latency that is "not proportional to full database size" for access-metadata writes; lexical search itself still scales linearly with corpus size, which can dominate latency as memory count grows. Out of strict spec scope but adjacent to its intent.
**Recommendation:** Consider migrating `memories_fts` to SQLite FTS5 (if available in the sql.js build) or capping scan cost; at minimum, document the linear behavior. Low priority given current scale.

## Logging & observability

### [Medium · High · S] Degraded embedding startup is silent — `src/index.ts:59`
**Issue:** When credentials are missing, `createEmbeddingProvider` returns a `DegradedEmbeddingProvider` (`src/embedding/index.ts:144,154`) but neither the factory nor `main()` logs anything. The server proceeds and only surfaces the condition lazily, at request time or via `/health`.
**Why it matters:** The degraded-embedding spec and design Decision 3 ("Prioritize fail-safe semantics over silent degradation") expect operators to be made aware of degraded startup. A server silently running without embeddings is exactly the "hidden failure" class the proposal set out to eliminate. The fail-closed auth path correctly logs a high-visibility warning (`src/transport/middleware.ts:160`); the embedding path should match.
**Recommendation:** Emit `logger.warn({ event: 'embedding_degraded', provider, reason: 'missing credentials' })` at startup when the degraded provider is selected. Plumb the degraded flag (already exposed as `degraded = true`, `src/embedding/index.ts:109`) into `main()`.

## Stability & reliability

### [Low · High · S] ADD path persists SQLite on Qdrant failure (drift), unlike UPDATE rollback — `src/storage/index.ts:27-43`
**Issue:** `writeMemory` inserts into SQLite, then on Qdrant upsert failure marks `vector_synced=false`, flushes, and throws (`src/storage/index.ts:36-39`). The cross-store-atomicity spec scenario is written for the *update* path ("SQLite mutation is attempted with a new vector and Qdrant upsert fails → SQLite rolled back"), which `updateMemory` honors (`src/storage/index.ts:93`). The ADD path instead uses a deliberate reconciliation/drift model and leaves committed metadata.
**Why it matters:** This is a defensible design (unsynced rows are reconciled later via `reconcileVectorsFromSqlite`), and the spec scenario technically names the update path, so it is compliant. But the inconsistency between ADD (persist + flag) and UPDATE (roll back) is a latent surprise: a caller seeing an error from `remember` may still find the memory present in SQLite/lexical search.
**Recommendation:** No change required for compliance. Document the ADD-vs-UPDATE failure semantics so operators/agents understand that a failed `remember` can still leave a lexically-searchable, vector-unsynced row.

### [Low · Med · S] `collection://{name}` truncates to first 50 memories before filtering — `src/resources/index.ts:234-237`
**Issue:** The resource lists the first 50 memories in the namespace (`listMemories(namespace, 50)`) and then filters by collection in JS. Memories in the target collection beyond the newest 50 namespace rows are silently dropped, with no `truncated` flag or cursor.
**Why it matters:** The proposal emphasizes non-lossy, observable results. This path can return an arbitrary, silently-incomplete subset for any collection that isn't among the newest rows — a quieter cousin of the "silent empty results" anti-pattern. It is not directly named in a scenario, so not a compliance failure.
**Recommendation:** Use a collection-scoped query (`listMemoryIdsInCollection` / `countMemoriesInCollection` already exist) with proper limit + cursor, or at least surface a `truncated` indicator.

## Security

### [Medium · High · S] Bearer token compared with non-constant-time `!==` — `src/transport/middleware.ts:34`
**Issue:** `match[1] !== expectedToken` short-circuits on the first differing byte, making the comparison timing-dependent.
**Why it matters:** The fail-closed-auth capability hardens external HTTP exposure; once auth is *enabled* on an externally reachable host, a timing side-channel theoretically allows incremental token recovery. Express's default behavior and network jitter make this hard to exploit, but constant-time comparison is the standard expectation for bearer tokens and is a near-free fix.
**Recommendation:** Compare with `crypto.timingSafeEqual` over equal-length buffers (guard length first to avoid throwing), e.g. derive both as `Buffer.from(value)` and compare only when lengths match.

## Maintainability & code quality

### [Low · Med · M] MCP "structured content" is JSON-in-text, not `structuredContent` — `src/index.ts:111`
**Issue:** The CallTool handler returns `{ content: [{ type: 'text', text: JSON.stringify(result) }], isError? }`. The `mcp-structured-contracts` requirement states responses should "include structured payload without requiring JSON parsing from plain text," which the MCP spec satisfies via the `structuredContent` field on `CallToolResult`. The current shape still requires clients to `JSON.parse` the text block.
**Why it matters:** Agents/runtimes that consume `structuredContent` (and validate against an `outputSchema`) get nothing structured; the requirement is met only in spirit. The `isError` half of the same spec *is* correctly implemented, which makes the partial adoption easy to overlook.
**Recommendation:** Add `structuredContent: result` (and optionally `outputSchema` in tool defs) alongside the text block for successful, object-shaped results. Keep the text block for backward compatibility (already a documented mitigation in design Risks). Update task 3.x / spec scenario interpretation, or downgrade the requirement wording if JSON-in-text is intentionally the contract.

## Testing & coverage

### [Low · High · S] No test asserts atomic-replace write semantics — `src/storage/sqlite.ts:1378`
**Issue:** Task 5.6 lists "atomic write safety" as a regression-test target. `atomicWriteFileSync` (tmp-write + rename) is exercised indirectly by any flush, but no test asserts the atomic behavior itself (e.g. a `.tmp` intermediate, rename to target, or that a simulated mid-write failure leaves the prior file intact). `grep` for `atomicWriteFileSync`/`.tmp`/`rename` in `*.test.ts` returns nothing.
**Why it matters:** The atomic-write requirement exists precisely to prevent truncated partial files; without a guarding test, a future refactor of `flush()` back to a direct `writeFileSync` would silently reintroduce the corruption risk.
**Recommendation:** Add a focused unit test on `atomicWriteFileSync` (assert tmp then rename, and that an existing target survives a thrown write) — small and high-value.

## Dependencies & supply chain

No issues found. The change introduces no new runtime dependencies; it relies on existing `sql.js`, `express`, `@modelcontextprotocol/sdk`, `pino`, `uuid`, and Node built-ins (`node:fs`, `node:crypto` recommended for finding 1). All imports use `.js` ESM extensions per convention.

## Recommendations (prioritized)

1. **(Security, S)** Replace `!==` token comparison with `crypto.timingSafeEqual` (finding 1).
2. **(Observability, S)** Log a high-visibility warning when embedding starts degraded (finding 2) — closes the only real spec gap against design Decision 3.
3. **(Testing, S)** Add an atomic-write unit test to fully satisfy task 5.6 (finding 4).
4. **(Maintainability, M)** Add MCP `structuredContent` to successful tool results to fully meet the structured-contracts requirement, not just its `isError` half (finding 3).
5. **(Reliability, S)** Make `collection://{name}` collection-scoped with limit/cursor, or flag truncation (finding 6).
6. **(Docs, S)** Document the ADD-vs-UPDATE cross-store failure semantics so a failed `remember` leaving a vector-unsynced row is expected behavior (finding 5).
7. **(Perf, S)** Note/plan FTS5 migration for lexical search scaling (finding 7); low priority.
