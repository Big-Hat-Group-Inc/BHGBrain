# Code Audit — OpenSpec proposal `fix-dedup-noop-and-collection-delete-consistency`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `fix-dedup-noop-and-collection-delete-consistency`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM (`.js` import extensions), Zod config, Pino logging, Vitest co-located tests, sql.js + Qdrant storage
- **Files reviewed:** 9 (`src/pipeline/index.ts`, `src/pipeline/index.test.ts`, `src/tools/index.ts`, `src/tools/index.test.ts`, `src/storage/index.ts`, `src/storage/sqlite.ts`, `src/storage/qdrant.ts`, `src/domain/schemas.ts`, `README.md`) plus the 4 proposal artifacts

## Executive summary

The implementation is substantially complete and faithful to the proposal. The `NOOP` dedup branch is now explicit, non-mutating, and defended against missing targets; collection deletion is a guarded cascade that deletes Qdrant vectors and SQLite memory rows before the metadata row, with per-memory audit events and a deterministic response payload. All 13 `tasks.md` items and all spec scenarios are implemented and covered by tests. No Critical or High findings. The notable risk is a latent cross-store consistency gap: emptiness counting filters on `archived = 0` while the non-force delete path removes only metadata, so an archived-only collection would orphan SQLite rows — currently not triggerable because no code sets `memories.archived = 1`, but a correctness landmine for future lifecycle work. Remaining findings are Low-severity quality/observability items (redundant scan, minor design-order drift, silent vector-cleanup path).

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Req: NOOP dedup decision is terminal (no insert/update/upsert) | Done | `src/pipeline/index.ts:145-157` returns before ADD/UPDATE branches; verified no `writeMemory`/`updateMemory` reached |
| Scenario: High-similarity candidate resolves to NOOP | Done | `classifyOperation` `src/pipeline/index.ts:240-242`; handled `:145-157`; test `src/pipeline/index.test.ts:48-65` |
| Req: NOOP response returns canonical existing metadata | Done | `src/pipeline/index.ts:150-156` returns existing `id/summary/type/created_at` |
| Scenario: Existing record found for NOOP target | Done | `src/pipeline/index.ts:146-156` |
| Scenario: NOOP target missing in SQLite → internal error | Done | `src/pipeline/index.ts:147-149` throws `internal(...)`; test `src/pipeline/index.test.ts:67-83` |
| Req: Collection delete is consistency-preserving | Partial | Force path cascades (`src/storage/index.ts:155-163`); but non-force emptiness check filters `archived = 0` (`src/storage/sqlite.ts:543`) — latent orphan gap (Finding 1) |
| Scenario: Delete empty collection | Done | `src/tools/index.ts:217-222` metadata delete; test `src/tools/index.test.ts:76-89` |
| Scenario: Delete non-empty without force → CONFLICT, nothing removed | Done | `src/tools/index.ts:201-206`; test `src/tools/index.test.ts:53-58` |
| Scenario: Force delete non-empty (SQLite rows + Qdrant vectors + metadata last) | Done | `src/storage/index.ts:155-163` then metadata at `src/tools/index.ts:217`; test `src/tools/index.test.ts:60-74` |
| Req: Collection delete reports deterministic outcomes | Done | `src/tools/index.ts:222` returns `{ok, namespace, name, deleted_memory_count}` |
| Scenario: Force delete response includes name + deleted count | Done | `src/tools/index.ts:222`; test `src/tools/index.test.ts:68-69` |
| Task 1.1 Explicit NOOP branch returning existing metadata | Done | `src/pipeline/index.ts:145-157` |
| Task 1.2 Defensive handling for missing NOOP target id | Done | `src/pipeline/index.ts:147-149` |
| Task 1.3 Tests: NOOP classification, response shape, no-mutation | Done | `src/pipeline/index.test.ts:48-83` |
| Task 2.1 Extend delete schema/API with `force` | Done | `src/domain/schemas.ts:70`; `src/tools/schemas.ts:91` |
| Task 2.2 Store methods to count/delete memories by (ns, collection) | Done | `src/storage/sqlite.ts:541,988,1125`; `src/storage/index.ts:151-163` |
| Task 2.3 Guarded delete: reject non-empty without force | Done | `src/tools/index.ts:201-206` |
| Task 2.4 Forced cascade (SQLite, Qdrant, metadata last) | Done (minor order drift) | `src/storage/index.ts:155-163` + `src/tools/index.ts:217`; Qdrant deleted before SQLite rows vs design "SQLite then Qdrant" (Finding 3) |
| Task 2.5 Deterministic payload incl. deleted memory count | Done | `src/tools/index.ts:222` |
| Task 3.1 Tests: empty / non-empty-non-force / forced cascade | Done | `src/tools/index.test.ts:53-105` (incl. failure-surfacing test) |
| Task 3.2 Audit/metrics consistent for collection vs memory deletion | Done | per-memory `logAudit('FORGET', ...)` `src/tools/index.ts:212-214`; gauge `:221` |
| Task 3.3 Update docs/examples | Done | `README.md:2189`, `:2211-2216`, `:2582-2589` |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | Low | Medium | S | Stability/consistency | `src/storage/sqlite.ts:543` | Emptiness count filters `archived = 0`; non-force delete removes only metadata → archived-only collection orphans rows (latent) |
| 2 | Low | High | S | Performance | `src/storage/index.ts:156-158` | `deleteCollectionData` scans collection rows twice (`listMemoryIds` + `deleteMemoriesInCollection`) |
| 3 | Low | High | S | Maintainability | `src/storage/index.ts:157-158` | Cascade deletes Qdrant before SQLite rows; design.md specifies SQLite rows then Qdrant |
| 4 | Low | Medium | S | Logging | `src/storage/qdrant.ts:218-223` | Qdrant `deleteCollection` swallows not-found without any log; bulk-delete cascade has no operator log entry |

## Quick wins

- Finding 2: drop the separate `listMemoryIdsInCollection` call and return the `ids` already produced by `deleteMemoriesInCollection` (it builds and returns them). One-line change in `src/storage/index.ts:155-163`.
- Finding 3: reorder the two delete calls in `deleteCollectionData` to match the documented contract (SQLite memory rows, then Qdrant), or update `design.md` to match the (safe) implemented order.

## Performance

### [Low · High · S] Collection-scoped rows scanned twice during forced delete — `src/storage/index.ts:156-158`
**Issue:** `deleteCollectionData` calls `listMemoryIdsInCollection(namespace, collection)` to collect ids, then calls `deleteMemoriesInCollection(...)` which independently re-runs `SELECT id FROM memories WHERE namespace = ? AND collection = ?` (`src/storage/sqlite.ts:990-997`) and returns those same ids. The id list is computed twice.
**Why it matters:** Redundant full scan of the collection on every forced delete; wasteful for large collections and the very `O(n)` path the proposal is meant to make deterministic.
**Recommendation:** Use the `ids` returned by `deleteMemoriesInCollection` directly (it already returns `{ deleted, ids }`) and remove the separate `listMemoryIdsInCollection` call and the `ids.length > 0 ? ... : removed` reconciliation at `:162`.

## Logging & observability

### [Low · Medium · S] Forced cascade and swallowed Qdrant not-found are unlogged — `src/storage/qdrant.ts:218-223`
**Issue:** `Qdrant.deleteCollection` silently returns on not-found (`:219-221`) with no log, and the cascade in `StorageManager.deleteCollectionData` emits no structured log of a bulk delete. Operator-facing audit is limited to per-memory `FORGET` events written in the tool layer (`src/tools/index.ts:212-214`); a destructive "deleted N memories + dropped Qdrant collection X" event is not recorded.
**Why it matters:** Forced deletes are irreversible and potentially large (called out as a risk in `design.md`). Without a single structured log line at the cascade boundary, post-incident reconstruction relies only on scattered per-id audit rows, and a Qdrant collection that was already absent (a possible drift indicator) leaves no trace.
**Recommendation:** Add a Pino `info`/`warn` log in `deleteCollectionData` summarizing namespace, collection, deleted count, and Qdrant outcome; optionally log at `debug` when Qdrant delete hits not-found.

## Stability & reliability

### [Low · Medium · S] `archived = 0` emptiness check can orphan archived rows on metadata-only delete — `src/storage/sqlite.ts:543`
**Issue:** `countMemoriesInCollection` filters `archived = 0` (`:543`), as do `listMemoryIdsInCollection` (`:1126`) and the id-collection select inside `deleteMemoriesInCollection` (`:990`). When `force` is not set and the count is 0, the tool takes the metadata-only path (`src/tools/index.ts:217`, `sqlite.deleteCollection`) and never invokes the cascade. A collection containing only `archived = 1` rows would therefore report empty, pass the non-force guard, and have its metadata removed while the archived `memories` rows remain — the exact "orphaned SQLite data" the proposal forbids. The actual `DELETE` inside `deleteMemoriesInCollection` (`:1008`) is unfiltered, so the forced path does clean archived rows; the gap is only on the non-force/metadata path.
**Why it matters:** This is a latent cross-store consistency hole in a change whose entire purpose is consistency. It is currently not reachable — retention archives via the separate `memory_archive` table and then hard-deletes rows (`src/backup/retention.ts:54-61`), and no code path sets `memories.archived = 1` — so confidence that it bites today is low. But any future feature that flips `archived` on a row reintroduces orphaning silently.
**Recommendation:** Make emptiness counting and the guard use the same predicate as the destructive DELETE (count all rows for the collection regardless of `archived`), or have `deleteCollection` (metadata) refuse when any rows for `(namespace, collection)` still exist. Add a test asserting an archived-only collection is not treated as empty.

## Security

No issues found. Delete is namespace-scoped, parameterized SQL throughout (`src/storage/sqlite.ts:983,1003-1008`), `force` is a validated boolean with safe `false` default (`src/domain/schemas.ts:70`), and the `.strict()` schema rejects unknown fields.

## Maintainability & code quality

### [Low · High · S] Cascade deletion order drifts from design.md — `src/storage/index.ts:157-158`
**Issue:** `design.md` (Decision 2 and Task 2.4) specifies "delete SQLite memories for `(namespace, collection)`, delete Qdrant collection, then delete collection metadata." The implementation deletes the Qdrant collection first (`:157`) and SQLite memory rows second (`:158`). Metadata-last is correctly preserved in the tool layer (`src/tools/index.ts:217`).
**Why it matters:** The implemented order is arguably safer (drop vectors before rows), but the divergence from the written contract makes the design doc misleading for future maintainers and weakens the value of the spec. Either order leaves no orphans given the current success-path; the issue is documentation/code drift, not a runtime defect.
**Recommendation:** Reconcile by either reordering the two calls to match `design.md`, or amending `design.md`/Task 2.4 to document the chosen vectors-first order and its rationale.

## Testing & coverage

No issues found. Coverage is strong and matches the spec scenarios: NOOP no-mutation and missing-target (`src/pipeline/index.test.ts:48-83`), non-force CONFLICT, forced cascade with count + audit-call assertions, empty delete, and a cleanup-failure-surfacing case that verifies metadata is not removed when the cascade throws (`src/tools/index.test.ts:53-105`), plus a store-level `deleteMemoriesInCollection` test (`src/storage/sqlite.test.ts:206`). One optional gap: no test asserting an archived-only collection is not mis-counted as empty (see Finding 1).

## Dependencies & supply chain

No issues found. The change introduces no new dependencies; it uses existing `uuid`, sql.js, and the Qdrant client already in `package.json`. No version-range or transitive-dependency changes are involved.

## Recommendations (prioritized)

1. **(Finding 1)** Align the non-force emptiness guard with the unfiltered DELETE predicate (or block metadata delete while any collection rows remain) and add an archived-only test — closes the only latent consistency gap in a consistency-focused change.
2. **(Finding 2)** Remove the duplicate collection scan in `deleteCollectionData` by reusing the ids returned from `deleteMemoriesInCollection`.
3. **(Finding 4)** Add a structured cascade-summary log (and a debug log on Qdrant not-found) for operator visibility on irreversible bulk deletes.
4. **(Finding 3)** Reconcile cascade ordering between `design.md` and `src/storage/index.ts` to eliminate doc/code drift.
