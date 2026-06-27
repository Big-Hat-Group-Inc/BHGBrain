# Code Audit — OpenSpec proposal `preserve-metadata-in-degraded-writes`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `preserve-metadata-in-degraded-writes`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 7 (`proposal.md`, `tasks.md`, `design.md`, `specs/degraded-write-collection-metadata/spec.md`, `src/pipeline/index.ts`, `src/storage/index.ts`, `src/storage/sqlite.ts`; plus tests `src/pipeline/index.test.ts`, `src/storage/index.test.ts`)

## Executive summary

The change is implemented cleanly and matches the proposal's intent. Degraded-mode fallback writes now route through `StorageManager.writeMemoryWithoutVector()`, which runs the *same* `ensureCollectionCompatible()` gate as normal writes — so collection metadata is created/validated and incompatible embedding spaces are rejected even when no vector is available. Unsynced rows are explicitly marked `vector_synced = false` and remain discoverable by `reconcileVectorsFromSqlite()`. Spec compliance is **fully Done** with verified test coverage for both the new-collection and reconciliation scenarios.

The remaining findings are not data-integrity defects; they are observability and minor-quality items. The single most material gap is that the degraded path is **operationally silent**: the embedding failure that triggers fallback is swallowed without any Pino log or metric, so an operator cannot tell a deployment has silently entered degraded mode and is accumulating unsynced rows. Headline counts: 0 Critical, 0 High, 3 Medium, 3 Low.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Req: Degraded writes preserve collection metadata (create/validate for namespace+collection) | Done | `src/storage/index.ts:45-56` calls `ensureCollectionCompatible()`; `:294-297` creates collection metadata with active model/dimensions |
| Scenario: Fallback write into a new collection → metadata created w/ configured model+dims; memory unsynced | Done | `src/storage/index.ts:294-297` `createCollection(...embedding.model, embedding.dimensions)`; `:48-51` forces `vector_synced: false`; test `src/storage/index.test.ts:170-174` |
| Req: Degraded writes preserve embedding compatibility checks | Done | `src/storage/index.ts:281-292` `ensureCollectionCompatible` throws `conflict()` on model/dim mismatch; shared by degraded path `:46` |
| Scenario: Fallback targets incompatible collection → write rejected, not silently persisted | Done (logic) / **untested** | Reject logic present `src/storage/index.ts:283-290`; **no test exercises the degraded-mode rejection branch** (see Testing finding T-1) |
| Task 1.1 Storage API for SQLite-only degraded writes recording collection metadata | Done | `writeMemoryWithoutVector()` `src/storage/index.ts:45-56` |
| Task 1.2 Apply normal collection compatibility checks in degraded mode | Done | Reuses `ensureCollectionCompatible()` `src/storage/index.ts:46` |
| Task 2.1 Replace direct SQLite fallback writes in pipeline with new path | Done | `src/pipeline/index.ts:305` calls `this.storage.writeMemoryWithoutVector(mem)` (no direct `sqlite.insertMemory`) |
| Task 2.2 Preserve explicit unsynced state for later reconciliation | Done | `src/pipeline/index.ts:297` `vector_synced: false`; storage re-forces it `src/storage/index.ts:50`; reconciler reads it `src/storage/sqlite.ts:753-768` |
| Task 3.1 Tests for degraded writes into new and existing collections | Partial | New-collection covered `src/storage/index.test.ts:170-174`; **existing-compatible-collection and existing-incompatible-collection not covered** (T-1) |
| Task 3.2 Tests for repair/reconciliation preconditions | Done | `src/storage/index.test.ts:178-239` cover reconcile success and mid-batch failure/retry; `ensureCollectionCompatible` is invoked per row `src/storage/index.ts:217-219` |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| L-1 | Medium | High | S | Logging | `src/pipeline/index.ts:125-130` | Embedding failure that triggers degraded fallback is swallowed with no log/metric — degraded mode is operationally invisible |
| L-2 | Medium | Medium | S | Logging | `src/storage/index.ts:45-56` | No log or counter when a degraded (unsynced) row is persisted; unsynced backlog grows silently |
| S-1 | Medium | High | M | Testing | `src/storage/index.test.ts:163-176` | Spec's incompatible-collection rejection scenario in degraded mode is unverified; existing-collection degraded write untested |
| L-3 | Low | High | S | Maintainability | `src/storage/index.ts:48-51` | `vector_synced: false` is force-overridden in storage, masking caller mistakes and duplicating the pipeline's intent |
| L-4 | Low | Medium | S | Stability | `src/storage/index.ts:45-56` | Degraded write is not wrapped in a transaction: `memories` + `memories_fts` + collection insert can partially apply on failure |
| L-5 | Low | Low | S | Performance | `src/pipeline/index.ts:249-315` | Degraded fallback skips near-dedup entirely; rapid repeated degraded writes of near-duplicate content create unbounded unsynced rows |

## Quick wins

- **L-1 / L-2 (S):** Add a single Pino `warn` at the point degraded fallback is taken (`src/pipeline/index.ts:126`) including `namespace`, `collection`, and the embedding error, plus a `debug`/metric increment in `writeMemoryWithoutVector`. This makes degraded mode observable for near-zero effort.
- **L-3 (S):** Drop the redundant `vector_synced: false` spread override or replace it with an assertion.

## Performance

### [Low · Low · S] Degraded fallback bypasses near-dedup, allowing unsynced-row growth — `src/pipeline/index.ts:249-315`
**Issue:** `deterministicFallback()` performs only exact-checksum dedup (inherited from `decide()` at `src/pipeline/index.ts:110`) and then always ADDs. Unlike the normal path, it does no similarity-based NOOP/UPDATE collapsing (because no vector exists). During a prolonged embedding outage, repeated near-duplicate `remember` calls each create a distinct unsynced row.
**Why it matters:** The unsynced backlog (`vector_synced = 0`) can grow without bound during an outage; reconciliation later has to embed and upsert every one, and near-duplicates that the normal path would have merged are now permanent distinct memories.
**Recommendation:** Accept as a documented non-goal (the design explicitly defers the reconciliation worker), or add a cheap fulltext/trigram pre-check in the fallback to short-circuit obvious duplicates. Low priority — correctness is preserved, only volume is affected.

## Logging & observability

### [Medium · High · S] Embedding failure triggering degraded fallback is swallowed silently — `src/pipeline/index.ts:125-130`
**Issue:** When `this.embedding.embed()` throws and `fallback_to_threshold_dedup` is enabled, the pipeline catches the error and returns `deterministicFallback(...)` without logging anything. The error object is discarded. There is no Pino logger threaded into `WritePipeline` at all.
**Why it matters:** The system can silently transition into degraded operation — persisting unsynced rows that will never be searchable until a reconciliation job runs — and nothing in the logs records it. Operators get no signal that embeddings are down, and the only evidence is a slowly rising `countUnsyncedVectors()`. This is the highest-value gap in the change.
**Recommendation:** Inject a Pino logger into `WritePipeline` and emit `logger.warn({ event: 'degraded_write', namespace, collection, err }, 'embedding unavailable, persisting unsynced memory')` at line 126 before falling back.

### [Medium · Medium · S] No log or metric when an unsynced degraded row is persisted — `src/storage/index.ts:45-56`
**Issue:** `writeMemoryWithoutVector()` persists a row with `vector_synced = false` but emits no structured log and increments no metric/counter. The repo already has a `health/metrics` module, so the pattern exists.
**Why it matters:** Without a counter, dashboards/alerts cannot track degraded-write rate or the size of the unsynced backlog over time; the only probe is an on-demand `COUNT(*)` (`src/storage/sqlite.ts:745-751`).
**Recommendation:** Increment a `degraded_writes_total` counter (and/or a gauge fed by `countUnsyncedVectors`) here, and optionally a `debug` log line.

## Stability & reliability

### [Low · Medium · S] Degraded write is not atomic across the three SQLite mutations — `src/storage/index.ts:45-56`
**Issue:** `writeMemoryWithoutVector` → `insertMemory` runs two `db.run` statements (the `memories` row at `src/storage/sqlite.ts:341` and the `memories_fts` row at `:375`), and `ensureCollectionCompatible` may also `createCollection`. These are not wrapped in a `BEGIN/COMMIT`. If the second statement throws, the first is already applied in the in-memory sql.js DB and could be flushed.
**Why it matters:** A partial insert (memory row without its FTS row, or vice versa) corrupts fulltext search consistency for that record. Probability is low (sql.js is in-memory and these inserts rarely fail mid-way), hence Low severity — but the normal `writeMemory` path shares the same non-transactional `insertMemory`, so it is a pre-existing pattern rather than new to this change.
**Recommendation:** Wrap the `memories` + `memories_fts` inserts in a transaction in `insertMemory`. Track as tech-debt for the storage layer broadly, not blocking for this change.

## Security

No issues found. The degraded path runs `containsSecret()` rejection before reaching fallback (`src/pipeline/index.ts:43-45`), inherits the same `assertMutableAllowed()` lifecycle guard via `insertMemory` (`src/storage/sqlite.ts:333`), and adds no new external input surface, credentials, or deserialization.

## Maintainability & code quality

### [Low · High · S] Redundant `vector_synced: false` override masks caller intent — `src/storage/index.ts:48-51`
**Issue:** The pipeline already sets `vector_synced: false` on the record (`src/pipeline/index.ts:297`), and `writeMemoryWithoutVector` re-forces it via `{ ...mem, vector_synced: false }`. Two places assert the same invariant.
**Why it matters:** The defensive override is harmless but hides the case where a caller mistakenly passes `vector_synced: true` — it is silently corrected instead of flagged, making the contract ambiguous. The duplicated literal also drifts if the flag's meaning changes.
**Recommendation:** Keep the override as the single source of truth and remove the pipeline-side assignment (or vice versa), and add a code comment that this method always persists unsynced. Optionally assert in dev builds that the incoming value is not `true`.

## Testing & coverage

### [Medium · High · M] Degraded incompatible-collection rejection and existing-collection paths are untested — `src/storage/index.test.ts:163-176`
**Issue:** The only degraded-write test stubs `getCollection` to return `null` (new collection). The spec's second scenario — *"fallback targets incompatible collection metadata → the write is rejected"* (`specs/.../spec.md:14-17`) — and Task 3.1's "existing collections" case are not exercised. `ensureCollectionCompatible`'s reject branch (`src/storage/index.ts:283-290`) is only covered, if at all, by normal-path tests, not via `writeMemoryWithoutVector`.
**Why it matters:** This is a core spec guarantee (data integrity: no silent persistence into a mismatched embedding space). A regression that, e.g., made the degraded path skip the compatibility check would pass the current suite.
**Recommendation:** Add two cases under `describe('degraded writes')`: (1) `getCollection` returns a compatible record → `createCollection` NOT called, `insertMemory` called with `vector_synced: false`; (2) `getCollection` returns a record with mismatched `embedding_dimensions` → `expect(() => storage.writeMemoryWithoutVector(baseMem)).toThrow(/Cannot mix embedding spaces/)` and `insertMemory` NOT called.

Reconciliation precondition coverage (Task 3.2) is good: success and mid-batch-failure/retry are both verified (`src/storage/index.test.ts:178-239`).

## Dependencies & supply chain

No issues found. The change introduces no new dependencies; it reuses `uuid`, sql.js, and the existing Qdrant client already vetted elsewhere in the repo.

## Recommendations (prioritized)

1. **(Medium, S) Make degraded mode observable** — add a Pino `warn` at `src/pipeline/index.ts:126` capturing the embedding error + namespace/collection, and a `degraded_writes_total` metric in `writeMemoryWithoutVector` (L-1, L-2). Highest value: turns a silent failure mode into an alertable one.
2. **(Medium, M) Close the spec test gap** — add degraded-mode tests for compatible-existing and incompatible-collection rejection so the data-integrity guarantee is regression-protected (S-1).
3. **(Low, S) Tidy the duplicated `vector_synced` invariant** and add a clarifying comment (L-3).
4. **(Low, S) Consider transactional `insertMemory`** for the `memories`+FTS pair as storage-layer tech debt (L-4).
5. **(Low, Low) Document** that degraded fallback intentionally skips near-dedup, or add a cheap FTS pre-check, to bound unsynced-row growth during long outages (L-5).
