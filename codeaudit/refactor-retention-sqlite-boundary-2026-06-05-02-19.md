# Code Audit — OpenSpec proposal `refactor-retention-sqlite-boundary`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `refactor-retention-sqlite-boundary`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 6 (`src/backup/retention.ts`, `src/storage/sqlite.ts`, `src/storage/index.ts`, `src/backup/retention.test.ts`, `src/storage/sqlite.test.ts`, proposal/design/spec/tasks docs)

## Executive summary

The proposal's stated goal — remove `as any` access to the private SQLite `db` field
from the retention service and replace it with a typed, narrowly-scoped store method —
is **fully realized in the current tree**. `RetentionService.markStaleMemories`
(`src/backup/retention.ts:76`) calls `this.storage.sqlite.listStaleCandidateIds(...)`
and `this.storage.sqlite.markStale(...)`, both of which are declared on the
`SqliteStore` interface (`src/storage/sqlite.ts:69,71`) and reached through the
`public readonly sqlite` member of `StorageManager` (`src/storage/index.ts:12`). A grep
for `as any` and direct `.db` access across `src/backup/` returns nothing. Type checking
(`tsc --noEmit`), ESLint, and both relevant Vitest suites (28 tests) all pass.

One notable observation: git history shows `src/backup/retention.ts` was *created* in
commit `9099d68` already using `listStaleCandidateIds`, with no `as any` cast ever
present in committed history. The `as any` / `(this.storage.sqlite as any).db` situation
described in `proposal.md` and `design.md` therefore reflects either a transient local
state or an aspirational "before" snapshot, not a defect in committed code. The end
state nonetheless matches the spec, so compliance is satisfied; the documentation just
over-describes a problem the committed history never exhibited.

Findings are minor and quality-oriented: a small layering inconsistency (retention still
reaches across to `sqlite` for several other operations beyond the one refactored), a
logging gap (retention runs emit no Pino logs), and a behavioral-equivalence test that
asserts counts but not a true before/after invariant. No security, performance, or
dependency issues were found.

## Spec compliance

| Requirement / Task | Status | Evidence |
| --- | --- | --- |
| Req: Retention service uses typed storage interfaces (no private DB internals) | Done | `src/backup/retention.ts:80,82` call typed `listStaleCandidateIds`/`markStale`; interface decl `src/storage/sqlite.ts:69,71`; no `as any`/`.db` in `src/backup/` (grep). |
| Scenario: Mark stale memories execution (public typed API, no `any`) | Done | `markStaleMemories` `src/backup/retention.ts:76-86` uses only typed methods; `tsc --noEmit` + eslint pass. |
| Req: Retention behavior functionally equivalent after encapsulation | Done | SQL in `listStaleCandidateIds` `src/storage/sqlite.ts:595-607` (last_accessed < cutoff, stale=0, category IS NULL, archived=0); regression test asserts count `src/backup/retention.test.ts:48-63`. |
| Scenario: Equivalent dataset before/after refactor (stale count unchanged) | Partial | Test `src/backup/retention.test.ts:48-63` asserts `staleMarked === 1` for a fixed dataset, but there is no captured "before refactor" baseline; it validates current behavior, not an A/B equivalence. |
| Task 1.1 Add typed SQLite store method for stale-candidate lookup | Done | `listStaleCandidateIds` `src/storage/sqlite.ts:595-607` + interface `:71`. |
| Task 1.2 Add tests for new store method incl. edge cases | Done | `src/storage/sqlite.test.ts:105-131` (cutoff boundary + categorized-exclusion). |
| Task 2.1 Replace private DB access with typed store methods | Done | `src/backup/retention.ts:80,82`. |
| Task 2.2 Remove `as any` and compile-time boundary violations | Done | No `as any`/`.db` in `src/backup/` (grep); `tsc --noEmit` clean. |
| Task 3.1 Retention tests verifying stale-marked counts unchanged | Done (weakly) | `src/backup/retention.test.ts:48-63`; see Partial note above re: true before/after. |
| Task 3.2 Run lint/type checks and retention tests | Done | `npm run lint` (tsc + eslint) clean; `vitest run` retention+sqlite = 28 passed. |

Overall: **Done** for all requirements; one scenario is **Partial** (count asserted, but
not a literal before/after equivalence harness). Proposal/design narrative is mildly
**Drifted** from committed history (the `as any` "before" state is not in any commit).

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Low | High | S | Maintainability/Layering | `src/backup/retention.ts:31,90,98,105,109,121,155` | Retention still reaches across to `storage.sqlite.*` for many ops beyond the refactored path; boundary improved locally but not holistically. |
| 2 | Low | High | S | Logging | `src/backup/retention.ts:76-86` | No Pino logging on retention/GC runs; stale-mark and delete counts are not observable. |
| 3 | Low | Medium | S | Testing | `src/backup/retention.test.ts:48-63` | Equivalence scenario asserts a hardcoded count, not a before/after invariant; doc claims drift from committed history. |
| 4 | Info | High | S | Maintainability | `src/storage/sqlite.ts:595-607` | `listStaleCandidateIds` duplicates filter predicates already implicit in `getStaleMemories`; cutoff column (`last_accessed`) undocumented in spec. |

## Quick wins

- Add a single Pino `logger.info` in `markStaleMemories` and `runGc` reporting counts
  (Finding 2) — one line each, immediate observability gain.
- Add a short doc comment on `listStaleCandidateIds` noting it keys off `last_accessed`
  vs. the configured `decay_after_days` cutoff (Finding 4).

## Performance

No issues found. `listStaleCandidateIds` (`src/storage/sqlite.ts:595-607`) runs a single
prepared statement with a streamed cursor and frees it; `markStale` issues one UPDATE per
id with a single trailing `flushIfDirty` (`src/backup/retention.ts:84`), which is the
correct sql.js batching pattern (no per-id flush). For very large stale sets the per-id
UPDATE loop could become a single `UPDATE ... WHERE last_accessed < ?`, but at current
scale this is not a measurable concern.

## Logging & observability

### [Low · High · S] Retention runs emit no structured logs — `src/backup/retention.ts:76-86`

**Issue:** `markStaleMemories`, `runGc`, and `runConsolidation` return counts but never
log. Pino is the project's logging standard, yet retention is invisible in logs — an
operator cannot tell how many memories were marked stale, archived, or deleted on a given
run without instrumenting callers.

**Why it matters:** Retention mutates persistent state (marks rows stale, deletes via
`deleteMemories`). Silent state mutation with no audit trail in logs makes incident
diagnosis ("why did N memories disappear?") harder. Audit-log rows are written
(`src/backup/retention.ts:63`) but those are SQLite records, not operational logs.

**Recommendation:** Inject the Pino logger (or use the module logger) and emit
`logger.info({ staleMarked, decayDays }, 'retention.markStale')` and a similar line in
`runGc` with `{ scanned, archived, deleted }`.

## Stability & reliability

No issues found. The refactored path is synchronous, uses prepared statements that are
always `free()`d, and concludes with a single `flushIfDirty`. Tests pass and type/lint
are clean. `markStale` and `listStaleCandidateIds` share the same `category IS NULL AND
archived = 0` guard, so the candidate set and the marking target are consistent.

## Security

No issues found. Both new/used store methods use parameter binding
(`src/storage/sqlite.ts:599` `stmt.bind([cutoffIso])`; `:584` parameterized UPDATE); no
string interpolation of user input. No secrets, network, or auth surface touched by this
change.

## Maintainability & code quality

### [Low · High · S] Boundary improved locally but retention still reaches broadly into `storage.sqlite` — `src/backup/retention.ts:31,90,98,105,109,121,155`

**Issue:** The proposal's framing is "refactor the boundary between retention and the
SQLite layer." The specific `as any` path was removed, but `RetentionService` still calls
~12 distinct `this.storage.sqlite.*` methods directly (e.g. `listExpiredMemories` :31,
`getStaleMemories` :90, `countByTier`/`countArchivedMemories`/`countUnsyncedVectors`
:97-98, `listExpiringMemories` :105, `listArchive`/`searchArchive` :109/:113,
`getArchiveByMemoryId`/`deleteArchive` :121/:155). The encapsulation win is real for the
one method, but the service remains tightly coupled to the concrete `SqliteStore` surface
rather than a retention-scoped persistence interface.

**Why it matters:** The design doc's stated rationale ("storage owns query details,
service coordinates policy") is only partially achieved. Future SQLite refactors still
ripple into retention through these other call sites.

**Recommendation:** Optional follow-up — define a narrow `RetentionStore` interface
(the subset of methods retention needs) and depend on that, or route through the
`StorageManager` facade consistently. Out of scope for this proposal but worth a tracking
note; the design's Open Question ("expose via `StorageManager` facade or `SqliteStore`
directly?") is left unresolved in the implementation (it accesses `SqliteStore` directly).

### [Info · High · S] Cutoff column and predicate duplication — `src/storage/sqlite.ts:595-607`

**Issue:** `listStaleCandidateIds` filters on `last_accessed < cutoff` while the service
derives the cutoff from `decay_after_days` (`src/backup/retention.ts:77-79`). The spec
says "cutoff timestamp" without specifying the keyed column, and the predicate set
(`stale = 0 AND category IS NULL AND archived = 0`) overlaps the implicit filters in
`getStaleMemories` (`:590`). Not a bug, but the column choice is undocumented.

**Why it matters:** A reader of the spec cannot tell that decay is measured by last
access rather than creation/update time; this is a meaningful semantic detail.

**Recommendation:** Add a one-line doc comment and/or note in the spec that staleness is
keyed on `last_accessed`.

## Testing & coverage

### [Low · Medium · S] Equivalence scenario asserts a count, not a before/after invariant — `src/backup/retention.test.ts:48-63`

**Issue:** The spec scenario "the number of memories marked stale is unchanged" implies a
before/after comparison. The test asserts `staleMarked === 1` against a fixed three-row
dataset (old/new/categorized). This validates *current* behavior and the categorized
exclusion, which is good, but it is not a regression guard against the pre-refactor
implementation (which, per git history, never existed in a committed `as any` form).

**Why it matters:** The proposal's central risk mitigation was "before/after regression
tests for stale-marking counts." The committed test demonstrates correctness but not
equivalence to a prior baseline.

**Recommendation:** Acceptable as-is given there is no committed "before" implementation.
If stronger assurance is wanted, add a boundary case at exactly the cutoff timestamp
(currently only strictly-before and strictly-after are tested) to lock the `<` semantics.

## Dependencies & supply chain

No issues found. The change introduces no new dependencies; it uses existing `sql.js`
prepared-statement APIs and `uuid` (already present). No `package.json` change is implied
by this refactor.

## Recommendations (prioritized)

1. **(Logging, S)** Add Pino log lines to `markStaleMemories`/`runGc` reporting counts —
   highest value-per-effort; closes the only operational-visibility gap.
2. **(Docs/Spec, S)** Document that staleness is keyed on `last_accessed` and reconcile
   the proposal/design "before" narrative with committed history (the `as any` state is
   not in any commit) so the archived change record is accurate.
3. **(Testing, S)** Add an exact-cutoff boundary test to lock `<` semantics; optionally
   record an explicit baseline count to satisfy the "unchanged" scenario literally.
4. **(Maintainability, M — follow-up)** Consider a narrow `RetentionStore` interface to
   complete the boundary work the proposal began, resolving the design's open question
   about facade-vs-direct access. Out of scope for this change.
