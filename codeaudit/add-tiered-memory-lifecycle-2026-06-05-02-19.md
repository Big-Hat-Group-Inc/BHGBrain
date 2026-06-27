# Code Audit — OpenSpec proposal `add-tiered-memory-lifecycle`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `add-tiered-memory-lifecycle`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 16

Files reviewed: `src/domain/lifecycle.ts`, `src/domain/lifecycle.test.ts`, `src/domain/types.ts`, `src/config/index.ts`, `src/storage/sqlite.ts`, `src/storage/index.ts`, `src/storage/qdrant.ts`, `src/pipeline/index.ts`, `src/search/index.ts`, `src/health/index.ts`, `src/backup/retention.ts`, `src/backup/retention.test.ts`, `src/cli/index.ts`, `src/tools/index.ts`, `src/tools/schemas.ts`, `src/resources/index.ts`.

## Executive summary

The tiered-memory-lifecycle change is **substantially implemented and integrated** despite every box in `tasks.md` being unchecked (documentation drift). The domain model (`MemoryLifecycleService`), SQLite schema + migration, Qdrant payload indexes, write-pipeline tier assignment, search-path expiry filtering with access tracking and promotion, archive/revision storage, the `RetentionService` GC, CLI `gc`/`tier`/`archive`/`stats` commands, and health tier/drift reporting all exist and the project passes `tsc --noEmit` and ESLint cleanly.

The gaps are concentrated in the **operational tail** of the spec: there is **no scheduled cleanup job** (the `cleanup_schedule` config is dead), **no compaction** (`compaction_deleted_threshold` is dead), **no cleanup metrics** (duration/deleted/archived/compaction), and **no tier-transition audit events** (promotion/archive/revision/restore reuse only the generic `ADD`/`UPDATE`/`FORGET` audit codes). Two correctness drifts matter most: (1) **resource read paths (`memory://list`, `memory://{id}`) do not filter expired memories**, violating the "consistent lifecycle visibility across MCP tools, resources, and CLI" requirement; (2) **`runGc` deletes expired `T1` memories directly with no warning/review-window gate**, violating the explicit `T1`-requires-warning requirement. Cleanup also runs **without `beginLifecycleOperation` guarding and without degraded-health-on-failure handling**, so a partial archive/delete failure surfaces as a raw thrown error rather than the spec's deterministic degraded state.

No Critical security or data-leak issues were found; namespace scoping is preserved throughout the lifecycle paths.

## Spec compliance

| Requirement / Task | Status | Evidence |
| --- | --- | --- |
| Persist canonical lifecycle metadata (`retention_tier`, `expires_at`, `decay_eligible`, `review_due`, access, archival) | **Done** | `src/storage/sqlite.ts:148-161`, `src/domain/types.ts:39-52`; T0 → `expires_at` null + non-decay (`lifecycle.ts:63-80`) |
| Write pipeline assigns tiers deterministically (explicit → category → heuristics → extraction → default T2) | **Partial** | `src/domain/lifecycle.ts:46-61`, `src/pipeline/index.ts:99-107`. Order matches except **extraction recommendation is never consulted** (no extraction output feeds `assignTier`); default T2 OK |
| Retrieval enforces lifecycle visibility consistently across tools, resources, CLI | **Drifted** | Search filters expiry (`qdrant.ts:150-156`, `search/index.ts:212`) but **resources do not** (`src/resources/index.ts:61-67`, `73-92` return expired memories); `tier list` filters in JS only |
| T0/T1 remain eligible regardless of transient expiry | **Done** | `qdrant.ts:152` (`decay_eligible=false` short-circuit), `lifecycle.ts:122-125` |
| Successful read updates access state + sliding expiry | **Partial** | `src/search/index.ts:219,238-265` (batched, with promotion + sliding window). Resource `touchMemory` increments access but **does not extend expiry / promote** (`resources/index.ts:65`) |
| Promotion without auto-demotion | **Done** | `src/domain/lifecycle.ts:94-99` (T3→T2, T2→T1, never T0/T1; no demotion path) |
| Cleanup archives then deletes only eligible memories; T0 excluded; T1 needs warning window | **Partial/Drifted** | `src/backup/retention.ts:29-74` archives before delete and excludes T0, but **T1 is deleted as soon as `expires_at < now` with no review/warning gate** — violates `retention-and-degradation` spec |
| Foundational (T0) updates preserve revision history; index keeps latest only | **Done** | `src/storage/index.ts:73-75`, `sqlite.ts:223-231`; FTS rebuilt to latest (`sqlite.ts:458-467`) |
| Lifecycle admin via CLI + retention-aware MCP metadata | **Done** | CLI `tier show/set/list`, `gc --dry-run`, `archive`, `stats --by-tier` (`src/cli/index.ts:227-374`); `retention_tier`/`expires_at`/`expiring_soon` in search results (`types.ts:76-78`) |
| Health exposes tier budgets, expiring backlog, cleanup lag, SQLite/Qdrant drift | **Partial** | Tier counts, expiring_soon, archived, unsynced_vectors, over_capacity present (`src/health/index.ts:49-55`). **No cleanup-lag metric; drift is approximated by `unsynced_vectors` only — no SQLite↔Qdrant payload comparison** |
| Cleanup emits metrics (duration, deleted, archived, compaction) | **Missing** | No `incCounter`/`recordHistogram` calls in `src/backup/retention.ts`; `runGc` returns counts but emits nothing |
| Tier transitions emit audit events (promote/restore/archive/revise/delete; prior+new tier, actor, ts) | **Missing** | Only generic `ADD`/`UPDATE`/`FORGET` audit codes are logged; promotion (`search/index.ts:252`) and archive (`retention.ts:56`) and revision (`storage/index.ts:74`) emit no audit/structured event with prior/new tier |
| Cleanup failure preserves active memories + degraded health | **Missing** | `runGc` (`retention.ts:54-66`) has no try/catch, no `beginLifecycleOperation`, no degraded-health signal on partial failure |
| Task 1.1 domain types | **Done** | `src/domain/types.ts:11,39-52,171-196` |
| Task 1.2 SQLite schema + migration | **Done** | `src/storage/sqlite.ts:148-175`, `ensureMemoryColumns` `1294-1327` |
| Task 1.3 `memory_revisions` / `memory_archive` + typed APIs | **Done** | `sqlite.ts:223-246`, `773-...`, `insertRevision`/`listRevisions` |
| Task 1.4 Qdrant payload/index support | **Done** | `src/storage/qdrant.ts:57-68` |
| Task 2.1 lifecycle policy service | **Done** | `src/domain/lifecycle.ts` |
| Task 2.2 lifecycle assignment in write decision | **Done** | `src/pipeline/index.ts:99-107,159-217` |
| Task 2.3 shared retention-aware retrieval path | **Partial** | Search routed through `buildSearchResults`; resources/inject **not** routed through it (`resources/index.ts`) |
| Task 2.4 access tracking + sliding expiry after reads | **Partial** | Search path yes; resource path increments access only |
| Task 3.1 cleanup scanner + archive-before-delete + delete orchestration + scheduler | **Partial** | GC service exists and is CLI-invokable; **no scheduler reads `cleanup_schedule`** |
| Task 3.2 T0 revision persistence on update | **Done** | `src/storage/index.ts:73-75` |
| Task 3.3 CLI `tier`/`archive`/`gc`/`stats` | **Done** | `src/cli/index.ts:227-374` |
| Task 3.4 restore/reconciliation for archived/unsynced records | **Partial** | `restoreArchive` (`retention.ts:120-159`) and `reconcileVectorsFromSqlite` (`storage/index.ts:204-258`) exist; restore reuses original id with a checksum mismatch (see finding) |
| Task 4.1 health for tier budgets/lag/drift | **Partial** | budgets + drift-proxy present; cleanup lag missing |
| Task 4.2 audit events + metrics for promote/archive/delete/restore/compaction | **Missing** | none emitted |
| Task 4.3 unit tests for policy + tier dedup | **Partial** | `lifecycle.test.ts` covers assign/promote; **no test for `dedupThresholdFor`, `computeExpiry`, `extendExpiry`, `isExpiringSoon`** |
| Task 4.4 integration tests for partial-failure recovery, archive-before-delete, expiry filtering | **Partial** | `retention.test.ts:65-96` covers happy-path batched GC + archive; **no partial-failure/recovery test, no expiry-filter test** |
| Task 4.5 e2e CLI/MCP tests for tier mgmt, GC dry-run, tier stats | **Partial** | `cli/index.test.ts` referenced; no evidence of GC dry-run / tier e2e assertions in reviewed scope |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | High | High | M | Stability/Maintainability | `src/resources/index.ts:61-92` | Resource reads return expired memories — expiry filtering only on search path |
| 2 | High | High | S | Stability | `src/backup/retention.ts:54-66` | GC has no failure handling / lifecycle guard / degraded-health signal |
| 3 | High | Medium | S | Maintainability | `src/backup/retention.ts:29-33` | `T1` expired memories deleted with no warning/review-window gate (spec violation) |
| 4 | Medium | High | S | Logging | `src/backup/retention.ts`, `src/search/index.ts:252` | No tier-transition audit events or cleanup metrics |
| 5 | Medium | High | M | Maintainability | `src/config/index.ts:113,115` | `cleanup_schedule` and `compaction_deleted_threshold` are dead config (no scheduler, no compaction) |
| 6 | Medium | High | S | Stability | `src/cli/index.ts:304-342` | `tier set` / `tier list` / `gc --tier` accept unvalidated tier strings |
| 7 | Medium | Medium | S | Stability | `src/backup/retention.ts:128-159` | `restoreArchive` reuses original id with `checksum = memory_id`, corrupting dedup invariants |
| 8 | Low | High | M | Testing | `src/domain/lifecycle.test.ts`, `src/backup/retention.test.ts` | Policy + partial-failure + expiry-filter paths under-tested |
| 9 | Low | High | S | Maintainability | `src/storage/sqlite.ts:155,169,590` + `retention.ts:76-92` | Legacy `stale` column/path coexists with new lifecycle model |
| 10 | Low | Medium | S | Performance | `src/storage/qdrant.ts:153` | `Date.now()` re-evaluated per search; minor, but expiry boundary not request-stable |
| 11 | Info | High | — | Maintainability | `openspec/.../tasks.md` | All tasks unchecked despite shipped, lint-clean implementation |

## Quick wins

- Add `isExpired` filtering to `memory://list` and `memory://{id}` (finding 1) — small, closes a real visibility gap.
- Validate `tier` against the `['T0','T1','T2','T3']` enum in CLI `tier set/list` and `gc --tier` (finding 6) — reuse the same enum already in `src/tools/schemas.ts:16`.
- Wrap `runGc`'s archive/delete loop in try/catch and surface a degraded retention health state on failure (finding 2).
- Emit `incCounter`/`recordHistogram` for GC duration/deleted/archived (finding 4) — the `MetricsCollector` API already exists.

## Performance

### [Low · Medium · S] Per-search `Date.now()` for expiry boundary — `src/storage/qdrant.ts:153`
**Issue:** The Qdrant expiry filter computes `Math.floor(Date.now() / 1000)` inline for every search; `buildSearchResults` separately computes `new Date()` (`src/search/index.ts:178`). Two independent clocks for one request.
**Why it matters:** Negligible cost, but the two boundaries can disagree by up to a second, and the inline computation makes the filter harder to test deterministically.
**Recommendation:** Thread a single `now` (ms) from the search entry point into both the Qdrant filter and `buildSearchResults`.

Otherwise, the read path is sound: access updates are batched (`recordAccessBatch`, `src/search/index.ts:239`) and flushed via the deferred-flush mechanism rather than per-row, which is the right call for the in-memory sql.js DB.

## Logging & observability

### [Medium · High · S] No tier-transition audit events and no cleanup metrics — `src/backup/retention.ts`, `src/search/index.ts:252`
**Issue:** The `observability-health` spec requires structured audit events for promote/restore/archive/revise/delete (with prior tier, new tier, actor, timestamp) and cleanup metrics (duration, deleted, archived, compaction). Promotion (`search/index.ts:252`), archival (`retention.ts:56`), and revision creation (`storage/index.ts:74`) emit nothing. GC only logs generic `FORGET` audit rows (`retention.ts:63`) and returns counts to the caller without recording any metric.
**Why it matters:** Operators cannot see why a memory changed tier, how long GC took, or how much it archived/deleted — the exact diagnosability the spec was meant to add. Promotions are completely invisible.
**Recommendation:** Add a structured lifecycle-event emitter (Pino + audit row) carrying `{memory_id, prior_tier, new_tier, actor, timestamp, action}`; instrument `runGc` with `recordHistogram('gc_duration_ms', …)` and `incCounter('gc_deleted'/'gc_archived', n)` using the existing `MetricsCollector`.

## Stability & reliability

### [High · High · M] Resource read paths return expired memories — `src/resources/index.ts:61-92`
**Issue:** `memory://{id}` (`:61-67`) and `memory://list` (`:73-92`) read directly from SQLite (`getMemoryById`, `listMemories`) with no `isExpired`/`decay_eligible` filtering. Only the search path enforces expiry (Qdrant filter + `lifecycle.isExpired` at `src/search/index.ts:212`).
**Why it matters:** The `tiered-memory-lifecycle` spec requires lifecycle-aware visibility "consistently across MCP tools, resources, and CLI." An expired `T3` memory is excluded from `recall`/`search` but still surfaced verbatim through the `memory://` resource and `tier list`, producing inconsistent client-visible state and resurfacing data the lifecycle intended to retire.
**Recommendation:** Route resource reads through a shared retention-aware filter (or call `lifecycle.isExpired` before returning), excluding expired decay-eligible non-T0/T1 records the same way the search path does.

### [High · High · S] GC has no failure handling, lifecycle guard, or degraded-health signal — `src/backup/retention.ts:54-66`
**Issue:** `runGc` archives then calls `deleteMemories` with no `try/catch`, never calls `beginLifecycleOperation`/`endLifecycleOperation`, and has no path to report degraded health. The `retention-and-degradation` spec explicitly requires: "WHEN archival, delete, or compaction steps fail … THEN the system preserves recoverable active metadata … and surfaces a degraded health state instead of silently dropping records."
**Why it matters:** If Qdrant `deleteMany` throws mid-run (`storage/index.ts:135`), some vectors are deleted, the SQLite metadata loop never runs, archive rows may exist for memories that still have live metadata, and the error propagates raw to the CLI with no degraded-health flag. Concurrent search access writes are also not blocked during the destructive window.
**Recommendation:** Bracket the destructive phase with `beginLifecycleOperation('gc')`/`endLifecycleOperation` in a `finally`, wrap archive+delete in `try/catch`, and set a degraded retention health signal (or persist a reconciliation marker) on partial failure.

### [Medium · Medium · S] `restoreArchive` corrupts id/checksum invariants — `src/backup/retention.ts:128-159`
**Issue:** Restore rebuilds a memory with `id: archived.memory_id` and `checksum: archived.memory_id` (`:129,138`), content sourced from the archived **summary** (`:134`), then calls `writeMemory`. The checksum no longer matches the content, and reusing the original UUID can collide with a live record or a Qdrant point that was only partially deleted.
**Why it matters:** Exact-dedup keys on `checksum` (`pipeline/index.ts:110`); a bogus checksum silently defeats dedup for the restored record, and id reuse risks overwriting unrelated state after a partial GC.
**Recommendation:** Compute `checksum` from the restored content via `computeChecksum`, and allocate a fresh UUID (the code already falls back to `uuidv4()` only when `memory_id` is empty).

### [Medium · High · S] CLI accepts unvalidated tier strings — `src/cli/index.ts:304-342`
**Issue:** `tier set <id> <tier>`, `tier list --tier`, and `gc --tier` pass the raw CLI string straight into `buildMetadataForTier`, `updateMemory`, and `listExpiredMemories` with no enum check. The MCP tool schema validates `retention_tier` (`src/tools/schemas.ts:16`) but the CLI does not.
**Why it matters:** `bhgbrain tier set x t9` writes `retention_tier = 't9'`, which then sorts outside the `{T0..T3}` budget maps (`health/index.ts:174`) and is invisible to `countByTier`. Garbage tiers silently bypass lifecycle policy.
**Recommendation:** Validate against `['T0','T1','T2','T3']` (reuse the schema enum) and exit non-zero on mismatch.

### [High · Medium · S] `T1` deleted with no warning/review gate — `src/backup/retention.ts:29-33`
**Issue:** `runGc` selects every decay-eligible, non-T0 memory whose `expires_at < now` (via `listExpiredMemories`, `sqlite.ts:693-699`) and deletes it. The `retention-and-degradation` spec states `T1` "requires warning/review semantics before deletion eligibility," and the lifecycle scenario requires a flag-for-review step before any `T1` deletion path. `review_due` is written but never consulted by GC.
**Why it matters:** Institutional (`T1`) memories — explicitly the protected middle tier — are hard-deleted purely on TTL expiry, defeating the tier's purpose.
**Recommendation:** In GC, exclude `T1` from direct delete; instead surface T1 expired/`review_due`-past rows as review candidates (or gate deletion behind a separate confirmed step), keeping direct deletion to `T2`/`T3`.

## Security

No issues found. Namespace scoping is preserved across the lifecycle paths: pipeline writes carry `namespace` (`pipeline/index.ts:194`), Qdrant search forces `{key:'namespace', match:{value:namespace}}` (`qdrant.ts:145`), archive rows store `namespace` (`sqlite.ts:781`), and GC deletes are grouped by `namespace|collection` (`storage/index.ts:125-136`). No secrets are logged on these paths; `containsSecret` rejection remains in the write pipeline (`pipeline/index.ts:43`).

## Maintainability & code quality

### [Medium · High · M] Dead lifecycle config: no scheduler, no compaction — `src/config/index.ts:113,115`
**Issue:** `cleanup_schedule` (cron default `'0 2 * * *'`) and `compaction_deleted_threshold` are defined and validated but read nowhere in `src/` (grep confirms only the schema definitions). The design's "scheduled cleanup job" (Decision 4) and "compaction is threshold-driven" (Architecture → Cleanup Execution) are unimplemented; GC only runs when an operator invokes the CLI.
**Why it matters:** Vector hygiene over time — the stated motivation for the whole change — does not happen automatically. Operators must remember to run `bhgbrain gc`, and Qdrant is never compacted regardless of delete ratio. Dead config also misleads operators into thinking scheduling/compaction are active.
**Recommendation:** Either wire a scheduler that reads `cleanup_schedule` and invokes `RetentionService.runGc`, plus a compaction step gated on `compaction_deleted_threshold`, or remove the dead keys and document GC as manual-only until implemented.

### [Low · High · S] Legacy `stale` model coexists with tiered lifecycle — `src/storage/sqlite.ts:155,169,590` + `src/backup/retention.ts:76-92`
**Issue:** The proposal says stale-marking "becomes one internal signal, not the terminal behavior," yet `markStaleMemories`/`runConsolidation` (`retention.ts:76-92`), the `stale` column, `idx_memories_stale`, and `getStaleMemories` remain fully active alongside the new tier paths, with no single decision point reconciling the two.
**Why it matters:** Two parallel retention notions (stale vs. tier/expiry) invite drift and confusion about which governs deletion. Decision 5 wanted the stale signal subordinated to tier policy; today they are siblings.
**Recommendation:** Make stale an input to tier/expiry decisions (e.g., feed it into eligibility) rather than a parallel mechanism, or document the intended relationship explicitly.

### [Info · High · —] All tasks unchecked despite shipped implementation — `tasks.md`
**Issue:** Every item in `tasks.md` is `[ ]`, but the implementation exists, is integrated, and passes `tsc --noEmit` + ESLint. This is pure documentation drift and undercuts the OpenSpec contract's value as a status source.
**Recommendation:** Reconcile `tasks.md` against this audit (check Done items, annotate Partial/Missing) so the proposal reflects reality.

## Testing & coverage

### [Low · High · M] Policy and recovery paths under-tested — `src/domain/lifecycle.test.ts`, `src/backup/retention.test.ts`
**Issue:** `lifecycle.test.ts` (4 cases) covers `assignTier` and `shouldPromote` only — `dedupThresholdFor`, `computeExpiry`, `isExpired`, `isExpiringSoon`, `extendExpiry`, and `buildMetadata` (T0 null expiry, T1 review_due) are untested. `retention.test.ts` covers happy-path batched GC + archive but has **no** partial-failure/recovery test (Task 4.4), no expiry-filter retrieval test, and no T1-gating test. No GC `--dry-run` non-mutation assertion was found in the reviewed scope.
**Why it matters:** The most failure-prone behaviors (cross-store partial failure, expiry boundary, tier-specific dedup thresholds, dry-run safety) are exactly the untested ones, and several of the drift findings above would have been caught by them.
**Recommendation:** Add unit tests for the remaining `MemoryLifecycleService` methods (including T0 → null expiry and T1 → `review_due`), an integration test that throws from `qdrant.deleteMany` mid-GC and asserts preserved metadata + degraded health, and a retrieval test asserting expired T3 is excluded while T0/T1 remain.

## Dependencies & supply chain

No issues found. The change introduces no new third-party dependencies; it reuses `uuid` (already present) and the existing Qdrant/sql.js stack. No version or supply-chain concerns specific to this proposal.

## Recommendations (prioritized)

1. **Close the resource-read expiry gap** (finding 1, High) — filter expired memories in `memory://list`/`memory://{id}` to satisfy the consistent-visibility requirement.
2. **Make GC failure-safe and report degraded health** (finding 2, High) — guard with `beginLifecycleOperation`, try/catch, and a degraded retention signal.
3. **Gate `T1` deletion behind warning/review** (finding 3, High) — exclude T1 from direct GC delete; surface as review candidates.
4. **Validate CLI tier inputs** (finding 6, Medium) — reuse the existing enum; prevents corrupt tiers.
5. **Add tier-transition audit events + GC metrics** (finding 4, Medium) — required by `observability-health`.
6. **Implement or remove the scheduler and compaction** (finding 5, Medium) — wire `cleanup_schedule`/`compaction_deleted_threshold` or delete the dead config and document manual GC.
7. **Fix `restoreArchive` checksum/id handling** (finding 7, Medium).
8. **Backfill policy + partial-failure + expiry tests** (finding 8, Low) and reconcile `stale` vs. tier model (finding 9, Low).
9. **Update `tasks.md`** to reflect shipped state (finding 11, Info).
