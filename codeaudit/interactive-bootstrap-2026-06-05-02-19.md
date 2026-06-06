# Code Audit — OpenSpec proposal `interactive-bootstrap`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `interactive-bootstrap`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 11 (`src/bootstrap/sections.ts`, `src/bootstrap/session.ts`, `src/tools/bootstrap.ts`, `src/storage/sqlite.ts` [bootstrap section], `src/storage/index.ts` [`deleteMemory`], `src/tools/index.ts` [dispatch], `src/tools/schemas.ts`, `src/pipeline/parser.ts`, and the three co-located test files)

## Executive summary

The interactive-bootstrap feature is functionally implemented and well covered by unit and integration tests: all four actions (`start`/`submit`/`status`/`reset`) work, session state is persisted transactionally in SQLite, and the section definitions are correctly shared with the profile parser. Overall health is good. The most significant issue is a **pervasive 12-vs-10 section count drift**: the proposal, design, spec, and tasks all specify a 12-section interview, but the implementation, tests, and tool descriptions use 10 — so the code is internally consistent but has drifted from (or the spec was never updated to match) the written requirements. The only material reliability bug is a **reset ordering hazard** where tracked memory IDs are cleared from SQLite before the Qdrant vectors are deleted, orphaning vectors if deletion fails. Secondary gaps: bootstrap mutations are not audit-logged (unlike `forget`), and there is no per-section idempotency around partial submit failures. No security or dependency issues found. Headline severity counts: 0 Critical, 1 High, 4 Medium, 2 Low.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Req: Bootstrap tool `start` action (initiate/resume) | Done | `src/tools/bootstrap.ts:45-75`, `handleStart` |
| Scenario: First-time start returns first section | Done | `bootstrap.ts:46-74`; test `bootstrap.test.ts:56-59` |
| Scenario: Resume existing session → first incomplete | Done | `bootstrap.ts:47`, `session.ts:63-66`; test `bootstrap.test.ts:88-102` |
| Scenario: All sections complete → completion + summary | Done | `bootstrap.ts:49-61` |
| Req: Bootstrap `submit` (store memories via pipeline, advance) | Done | `bootstrap.ts:77-155` |
| Scenario: Successful submission (collection/tier/type/importance/tags, record IDs, next) | Done | `bootstrap.ts:105-125` uses `sectionDef` metadata; `WritePipeline.process` |
| Scenario: Submit for already-complete section → error + suggest reset | Done | `bootstrap.ts:97-99`; test `bootstrap.test.ts:165-177` |
| Scenario: Submit with section outside 1–12 → `INVALID_INPUT` | Drifted | Zod caps `section` at `TOTAL_SECTIONS`=10 (`bootstrap.ts:10`, `sections.ts:182`); range is 1–10 not 1–12 |
| Req: Bootstrap `status` returns progress | Done | `bootstrap.ts:157-180` |
| Scenario: Status with active session (per-section status, counts, total, last updated) | Done | `bootstrap.ts:166-179`, `session.ts:24-46` |
| Scenario: Status with no session → suggest start | Done | `bootstrap.ts:158-164`; test `bootstrap.test.ts:179-183` |
| Req: Bootstrap `reset` (delete section memories, mark pending) | Done | `bootstrap.ts:182-220` |
| Scenario: Reset complete section → delete tracked memories, mark pending, return count | Partial | `bootstrap.ts:196-219` works, but IDs are cleared before deletion (see Finding 2); count reflects only successful deletes |
| Scenario: Reset pending section → no-op message | Done | `bootstrap.ts:198-204`; test `bootstrap.test.ts:125-134` |
| Req: Session persistence across conversations (SQLite) | Done | `sqlite.ts:248-255` table; `sqlite.ts:1222-1292` CRUD |
| Scenario: Resume after client restart | Done | `session.ts:16-22`; integration test `bootstrap.test.ts:87-102` |
| Task 1.1 Create `sections.ts` with **12**-section array | Drifted | `sections.ts:19-180` defines **10** sections; comment line 15 says "10 storage-mapped sections" |
| Task 1.2 Unit tests verifying all 12 sections | Drifted | `sections.test.ts:5-7` asserts `toHaveLength(10)` |
| Task 1.3 Refactor ProfileParser to import shared mappings | Done | `parser.ts:2,20` `SECTION_MAPPINGS = BOOTSTRAP_SECTIONS` |
| Task 2.1 Add `bootstrap_sessions` table (namespace, section_number, status, memory_ids, updated_at) | Done | `sqlite.ts:248-255` |
| Task 2.2 `session.ts` CRUD (create, get, update, reset) | Done | `session.ts:13-67` |
| Task 2.3 Unit tests for session CRUD | Done | `src/bootstrap/session.test.ts` |
| Task 3.1 `bootstrap.ts` action routing + input validation | Done | `bootstrap.ts:17-43` |
| Task 3.2 `start` action | Done | `bootstrap.ts:45-75` |
| Task 3.3 `submit` action | Done | `bootstrap.ts:77-155` |
| Task 3.4 `status` action | Done | `bootstrap.ts:157-180` |
| Task 3.5 `reset` action | Done | `bootstrap.ts:182-220` |
| Task 4.1 Register `bhgbrain.bootstrap` tool with JSON schema | Done | `schemas.ts:125-139`; dispatch `tools/index.ts:87` |
| Task 5.1 Integration test full start→submit all→completion | Done | `bootstrap.test.ts:53-84` |
| Task 5.2 Integration test resume after restart | Done | `bootstrap.test.ts:87-102` |
| Task 5.3 Integration test reset deletes memories + re-submission | Done | `bootstrap.test.ts:105-152` |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | High | High | S | Maintainability | `sections.ts:15-180`, `schemas.ts:142-146` | Spec/proposal/design/tasks say 12 sections; code, tests, and tool descriptions use 10 — spec drift + inconsistent "12-section" strings |
| 2 | Medium | High | S | Stability | `sqlite.ts:1262-1280`, `bootstrap.ts:206-213` | Reset clears `memory_ids` in SQLite before Qdrant vectors are deleted; deletion failure orphans vectors with no recovery list |
| 3 | Medium | High | S | Logging | `bootstrap.ts:77-220` | No audit log entries for bootstrap submit/reset (memory create/delete), unlike `forget` (`tools/index.ts:140`) |
| 4 | Medium | High | M | Stability | `bootstrap.ts:105-125` | Multi-chunk submit is non-atomic: pipeline failure mid-loop leaves partially-stored memories and section still pending |
| 5 | Medium | Medium | S | Stability | `bootstrap.ts:91-95` | `submit` calls `exists()` then `createOrResume()` (which re-creates if missing) — redundant query; TOCTOU-style double check |
| 6 | Low | High | S | Maintainability | `session.ts:24-46`, `bootstrap.ts:46-49,128-132` | Redundant DB re-queries per action (`createOrResume` + `getStatus` both re-read all rows) |
| 7 | Low | Medium | S | Maintainability | `session.ts:32-36` | `last_updated` only considers complete sections; a reset (which updates `updated_at`) is invisible in status timestamp |

## Quick wins

- Finding 1: Resolve the 12-vs-10 drift — either restore the missing 2 sections per spec, or update the proposal/design/spec/tasks to 10 and fix the two "12-section" strings in `schemas.ts:142,146`. (Effort S)
- Finding 2: Reorder reset to delete vectors first, then clear `memory_ids`. (Effort S)
- Finding 3: Add `logAudit` calls for bootstrap memory create/delete. (Effort S)

## Performance

### [Low · High · S] Redundant full-session reads per action — `session.ts:24-46`, `bootstrap.ts:46-49,128-132`
**Issue:** Each action re-reads the entire session row set multiple times. `handleStart` calls `createOrResume` (full `SELECT`) then, on completion, `getStatus` (another `bootstrapSessionExists` + full `SELECT`). `handleSubmit` calls `createOrResume` twice (lines 95 and 128) plus `getStatus`. Section counts are then recomputed in JS from already-fetched rows.
**Why it matters:** Bootstrap is a low-frequency, small-N (10 rows) path, so the absolute cost is negligible — this is a code-clarity/efficiency note, not a hot-path problem. With sql.js the whole DB is in memory anyway.
**Recommendation:** Pass the already-fetched `sections` array into `getStatus`/count helpers instead of re-querying, or have `getStatus` accept rows. Low priority.

## Logging & observability

### [Medium · High · S] Bootstrap memory mutations are not audit-logged — `src/tools/bootstrap.ts:77-220`
**Issue:** `handleSubmit` creates memories via the pipeline and `handleReset` deletes them via `ctx.storage.deleteMemory`, but neither calls `ctx.storage.logAudit(...)`. Compare `handleForget` (`src/tools/index.ts:140`), which records a `FORGET` audit entry for every deletion. The bootstrap tool also never emits an info/debug log line for start/submit/reset actions.
**Why it matters:** The project documents "Audit Logging: All operations logged" as a security consideration (AGENTS.md). Bootstrap can create dozens of memories and delete them on reset with no audit trail, breaking that invariant and making it impossible to attribute or trace bootstrap-originated data changes.
**Recommendation:** Emit audit entries for each created memory ID on submit and each deleted ID on reset (mirroring `handleForget`), and add a structured Pino log line (`event: 'bootstrap'`, action, namespace, section) at info level for observability.

## Stability & reliability

### [Medium · High · S] Reset clears tracked IDs before deleting vectors — orphaned Qdrant data on failure — `src/storage/sqlite.ts:1262-1280`, `src/tools/bootstrap.ts:206-213`
**Issue:** `resetBootstrapSection` reads `memory_ids`, then immediately `UPDATE ... SET memory_ids = '[]'` in SQLite and returns the IDs to the caller. The handler then loops over those IDs calling `ctx.storage.deleteMemory(id)` (`bootstrap.ts:210`). `deleteMemory` throws `internal(...)` if the Qdrant delete fails (`storage/index.ts:108-111`). If that throw happens (or the process dies) after the SQLite row was already zeroed, the section's `memory_ids` are gone but the SQLite memory rows and/or Qdrant vectors remain — orphaned with no tracked recovery list.
**Why it matters:** This breaks the design's stated guarantee that `memory_ids` "provides an exact deletion list" (design.md decision 4) and leaves dangling vectors/rows that the `repair` tool may not reconcile back to a bootstrap section.
**Recommendation:** Delete the vectors/memories first, and only clear `memory_ids` / mark the section pending after the deletions succeed (or do it inside a try/catch that preserves the ID list on failure). Alternatively wrap the whole reset in a single transactional unit.

### [Medium · High · M] Multi-chunk submit is non-atomic — `src/tools/bootstrap.ts:105-125`
**Issue:** `submit` splits answers into paragraph chunks and stores each via a separate `await ctx.pipeline.process(...)` call in a loop. If the pipeline throws on chunk N (embedding/Qdrant failure), the earlier chunks are already persisted but `markComplete` is never reached, so the section stays `pending` with untracked memories. Re-submitting the same section then stores duplicates (or relies on dedup), and those first-batch IDs are never recorded in `memory_ids`, so a later reset won't clean them up.
**Why it matters:** Partial failure leaves orphaned, untracked bootstrap memories and a section that cannot be cleanly reset — the same orphan class as Finding 2 but on the write path.
**Recommendation:** Accumulate created IDs and, on any chunk failure, either roll back the already-stored memories before re-throwing, or persist the partial `memory_ids` to the section row so reset can still clean them. At minimum document the partial-write behavior.

### [Medium · Medium · S] Redundant existence check before createOrResume in submit/reset — `src/tools/bootstrap.ts:91-95,192-196`
**Issue:** Both `handleSubmit` and `handleReset` call `sessionMgr.exists(namespace)` and throw "No bootstrap session found" if absent, then immediately call `sessionMgr.createOrResume(namespace)` — which itself *creates* the session if it doesn't exist (`session.ts:16-22`). The guard and the auto-create are contradictory intent: the guard says "must exist", but the very next call would have silently created it.
**Why it matters:** It works today only because of call ordering, but it's fragile and confusing — a reader can't tell whether submit requires a prior `start`. The double round-trip is also wasted work.
**Recommendation:** Have submit/reset fetch the session once with a non-creating getter and throw if empty, removing the `createOrResume` call from these paths (keep auto-create only in `start`).

## Security

No issues found. Input is validated via a strict Zod schema with a namespace regex and bounded `answers` length (`bootstrap.ts:8-13`); SQL uses parameterized statements throughout (`sqlite.ts:1222-1292`); no secrets, no injection vectors, namespace scoping is enforced.

## Maintainability & code quality

### [High · High · S] 12-vs-10 section count drift across spec and code — `src/bootstrap/sections.ts:15-180`, `src/tools/schemas.ts:142-146`
**Issue:** The proposal, design, spec, and tasks consistently specify a **12-section** interview (proposal.md "12-section interview"; spec.md "all 12 sections", "section number outside 1–12"; tasks 1.1/1.2 "12-section"/"all 12 sections"). The implementation defines **10** sections (`sections.ts:19-180`), the test asserts `toHaveLength(10)` (`sections.test.ts:5`), the bootstrap tool description/schema cap at 10 (`schemas.ts:127,132`), and `TOTAL_SECTIONS` = 10. Separately, the *import* tool description and its `format` enum doc still say "12-section bootstrap format" (`schemas.ts:142,146`), now inconsistent with both the bootstrap tool (10) and... nothing — no path produces 12.
**Why it matters:** This is a genuine spec-compliance failure (multiple Drifted rows above) and an internal documentation inconsistency. A user reading the `import` tool sees "12-section" while the bootstrap tool says "10-section". The Zod validator rejects sections 11–12, contradicting the spec scenario "section number outside 1–12 → INVALID_INPUT".
**Recommendation:** Decide the canonical count. If 10 is correct, update proposal.md/design.md/spec.md/tasks.md to 10 and fix the two "12-section" strings in `schemas.ts`. If 12 is correct, add the two missing sections to `BOOTSTRAP_SECTIONS` and update the test. Keep `README.md` "MCP Tools Reference" in sync per CLAUDE.md.

## Testing & coverage

### [Low · Medium · S] Reset/submit failure paths are untested — `src/tools/bootstrap.test.ts`
**Issue:** Tests cover the happy paths and basic validation well (full flow, resume, reset, already-complete, missing-section, no-session). However the failure/edge paths flagged in Findings 2 and 4 are not exercised: there is no test where `deleteMemory` rejects during reset (to prove `memory_ids` aren't silently lost) and no test where `pipeline.process` rejects mid-loop on a multi-chunk submit. `deleteMemory` and `pipelineProcess` are mocks that always succeed (`bootstrap.test.ts:31-35`).
**Why it matters:** The two real reliability risks in this feature live precisely on those untested failure paths, so regressions there would pass CI.
**Recommendation:** Add tests that make the `deleteMemory` / `pipeline.process` mock reject and assert the section state and tracked IDs remain recoverable (after Findings 2/4 are fixed).

## Dependencies & supply chain

No issues found. The feature adds no new dependencies (as the proposal states), reusing `sql.js`, the existing `WritePipeline`, `zod`, and Pino. No unpinned or risky additions were introduced by this change.

## Recommendations (prioritized)

1. **Resolve the 12-vs-10 section drift (Finding 1, High/S).** Pick the canonical count, update the OpenSpec artifacts (proposal/design/spec/tasks) and the two "12-section" strings in `schemas.ts`, plus README per CLAUDE.md. This also clears four Drifted spec-compliance rows.
2. **Fix reset ordering (Finding 2, Medium/S).** Delete vectors before clearing `memory_ids`, preserving the ID list on failure.
3. **Add audit logging for bootstrap submit/reset (Finding 3, Medium/S).** Mirror `handleForget` so all memory mutations are auditable.
4. **Make multi-chunk submit failure-safe (Finding 4, Medium/M).** Persist partial IDs or roll back on chunk failure so orphans are recoverable.
5. **Simplify submit/reset existence handling (Finding 5, Medium/S)** and remove redundant session re-reads (Finding 6, Low/S).
6. **Add failure-path tests (Testing finding, Low/S)** once Findings 2 and 4 are addressed; consider including a reset in `last_updated` (Finding 7).
