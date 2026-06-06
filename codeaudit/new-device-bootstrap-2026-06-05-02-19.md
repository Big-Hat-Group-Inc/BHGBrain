# Code Audit — OpenSpec proposal `new-device-bootstrap`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `new-device-bootstrap`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 16

## Executive summary

The proposal — hydrate an empty local SQLite store from existing Qdrant payloads on a
new device — is **fully implemented** and matches the design. All five implementation
tasks plus the test task are Done, with 11 co-located tests added and the build/test
suite passing per `.openspec.yaml` (145 total). The integration points described in the
design (`QdrantStore.listAllCollections`/`scrollAll`, `StorageManager.bootstrapFromQdrant`,
the `src/index.ts` startup hook, and the `repair --from-qdrant` CLI) all exist and behave
as specified.

The audit surfaced one **High-severity correctness bug**: `upsertMemoryFromPayload` uses
two independent `INSERT OR IGNORE` statements (no transaction), and the `memories.type`
column carries a `CHECK(type IN ('episodic','semantic','procedural'))` constraint. A
Qdrant payload whose `type` is any other string is silently dropped by `OR IGNORE` on the
main table, yet the FTS row is still inserted and the function returns `true` — yielding an
orphan FTS entry, an inflated hydrated count, and a memory that surfaces in full-text search
but cannot be loaded. Because payload values are reconstructed verbatim with no enum
validation, this is reachable from real cross-device data.

A secondary concern is **proposal drift** with `device-namespace-partitioning`, whose spec
says the `repair` flow should filter by `device_id` (current device, or `--all-devices`).
`bootstrapFromQdrant` hydrates *every* device's memories unconditionally and exposes no
device filter on either the startup hook or the CLI. `new-device-bootstrap` explicitly lists
per-device filtering as a Non-Goal, so the two proposals are in tension and the `repair`
contract is ambiguous across the two changes.

Remaining findings are low-severity (in-memory buffering of full collections, count excludes
archived rows, logger-shape coupling, and naming collision between the CLI `repair` subcommand
and the existing `repair` MCP tool).

## Spec compliance

| Requirement / Task | Status | Evidence |
|---|---|---|
| Cap. `new-device-bootstrap-hydration` — auto-hydrate on startup when SQLite empty | Done | `src/index.ts:62-74` gates on `sqlite.countMemories()===0`, calls `bootstrapFromQdrant(logger)`, wrapped in try/catch that warns and does not crash |
| Cap. `repair-from-qdrant` — on-demand CLI hydration regardless of count | Done | `src/cli/index.ts:376-391` registers `repair --from-qdrant`, calls `bootstrapFromQdrant()`, prints summary |
| Task 1 — `scanAllCollections` (satisfied by existing `listAllCollections`/`scrollAll`) | Done | `src/storage/qdrant.ts:236-270` both methods present and used |
| Task 2 — `upsertMemoryFromPayload` idempotent insert by ID | Partial | `src/storage/sqlite.ts:382-432`: idempotent via `getMemoryById` guard (L409) — but two non-transactional inserts + CHECK risk (Finding 1) |
| Task 3 — `bootstrapFromQdrant` on `StorageManager`, per-collection logging, returns count | Done | `src/storage/index.ts:175-198` scans, scrolls, upserts, `flushIfDirty` per collection, logs progress, returns total |
| Task 4 — startup hydration in `src/index.ts`, try/catch | Done | `src/index.ts:62-74` |
| Task 5 — `repair --from-qdrant` CLI | Done | `src/cli/index.ts:376-391` |
| Task 6 — build + 11 tests pass | Done | `sqlite.test.ts:256-328` (5), `storage/index.test.ts:243-315` (4), `cli/index.test.ts:271-289` (2); `.openspec.yaml` records 145 total |
| Design: payload field mapping w/ defaults | Done | `src/storage/sqlite.ts:385-406` matches design table incl. epoch-seconds `expires_at` conversion (L401-406) |
| Design: progress log lines | Done | `src/storage/index.ts:181,192,196` emit the three documented messages |
| Cross-change: `repair` filters by `device_id` (per `device-namespace-partitioning`) | Drifted | No device filter in `bootstrapFromQdrant` (`src/storage/index.ts:175-198`) or CLI (`src/cli/index.ts:376-391`); see Finding 2 |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
|---|---|---|---|---|---|---|
| 1 | High | High | S | Stability | `src/storage/sqlite.ts:413-431` | `OR IGNORE` + CHECK(type) drops main row silently but still inserts FTS row and returns `true` → orphan FTS + inflated count |
| 2 | Medium | High | M | Maintainability | `src/storage/index.ts:175` / `src/cli/index.ts:388` | `repair`/bootstrap hydrates all devices; conflicts with `device-namespace-partitioning` device-filtered `repair` |
| 3 | Low | Medium | S | Performance | `src/storage/qdrant.ts:243-270` | `scrollAll` buffers an entire collection into one array before any insert; no streaming/back-pressure |
| 4 | Low | Medium | S | Stability | `src/storage/sqlite.ts:64` / `src/index.ts:64` | `countMemories()` excludes archived rows, so a device holding only archived rows re-triggers hydration |
| 5 | Low | Low | S | Maintainability | `src/cli/index.ts:377` vs `src/tools/schemas.ts:156` | CLI `repair` subcommand shares a name with the registered `repair` MCP tool (different semantics) |

## Quick wins

- Wrap the two inserts in `upsertMemoryFromPayload` in a try/catch (or validate `type`
  against the enum before insert) and only insert FTS / return `true` when the main-table
  insert actually took effect — fixes Finding 1 (S).
- Drop the dead `INSERT OR IGNORE` semantics for the FTS table or make both inserts share
  one outcome, removing the orphan-row path (S).

## Performance

### [Low · Medium · S] Whole-collection buffering during hydration — `src/storage/qdrant.ts:243`

- **Issue:** `scrollAll` accumulates every point of a collection into `allPoints` before
  returning (`src/storage/qdrant.ts:247-269`); `bootstrapFromQdrant` then iterates that full
  array (`src/storage/index.ts:185-190`). For the observed 141 vectors this is negligible, but
  a large cross-device corpus loads the entire payload set (content + summary + tags) into
  memory per collection with no streaming or back-pressure.
- **Why it matters:** On a genuinely large Qdrant backend, startup hydration could spike RSS
  and block the event loop during the synchronous insert loop.
- **Recommendation:** Process points page-by-page (yield each `scroll` batch to a callback /
  async generator) and `flushIfDirty` per batch rather than per collection, so memory stays
  bounded by `batchSize`.

## Logging & observability

No issues found. The three design-mandated progress lines are emitted with structured Pino
fields (`src/storage/index.ts:181,192,196`), and the startup path adds a clear empty-state
log plus a warn-level failure log (`src/index.ts:66,69,73`).

## Stability & reliability

### [High · High · S] CHECK violation on `type` silently drops the row but keeps the FTS entry — `src/storage/sqlite.ts:413-431`

- **Issue:** `upsertMemoryFromPayload` runs two independent statements with no enclosing
  transaction: `INSERT OR IGNORE INTO memories (...)` (L413-425) and `INSERT OR IGNORE INTO
  memories_fts (...)` (L426-429). The `memories.type` column has
  `CHECK(type IN ('episodic','semantic','procedural'))` (`src/storage/sqlite.ts:140`). The
  payload `type` is reconstructed verbatim with only a `typeof === 'string'` guard
  (L389) — no enum validation. If a payload carries any other string (corrupt data, a future
  type, a different writer), `OR IGNORE` silently skips the `memories` insert, but the FTS
  insert still succeeds and the method returns `true` (L431).
- **Why it matters:** The result is an orphan `memories_fts` row with no backing `memories`
  row: full-text search returns the id (`fullTextSearch`) but `getMemoryById` returns null, so
  the search→SQLite JOIN that motivated this entire proposal drops it again — silently. The
  hydrated count is also overstated, and the empty-DB idempotency guard (L409) won't protect a
  retry because the main row never landed.
- **Recommendation:** Validate `type` against the allowed set before insert (fall back to the
  documented `'semantic'` default on mismatch), and gate the FTS insert + `return true` on the
  main insert having actually applied (e.g. check `db.getRowsModified()` or re-query). Consider
  wrapping both statements in a single transaction so partial inserts cannot persist.

### [Low · Medium · S] `countMemories()` excludes archived rows so hydration may re-run — `src/index.ts:64`

- **Issue:** The startup gate uses `sqlite.countMemories()` (`src/index.ts:64`), which filters
  `archived = 0` (`src/storage/sqlite.ts:528-533`). A device whose only local rows are archived
  would report 0 and re-trigger a full Qdrant scan on every startup.
- **Why it matters:** Mostly benign (`INSERT OR IGNORE` + the L409 guard keep it idempotent),
  but it means an unnecessary full-collection scroll on each boot for that edge case, and the
  "new device" predicate is subtly inaccurate.
- **Recommendation:** Use a count that includes archived rows (or a cheap `SELECT EXISTS`) for
  the "is this device empty" decision, or document that archived-only is treated as empty.

## Security

No issues found. Hydration is read-only against Qdrant and writes only into the local store;
no new secrets, network surface, or auth paths are introduced. Payload strings are bound as
SQL parameters (`src/storage/sqlite.ts:419-429`), so there is no injection exposure.

## Maintainability & code quality

### [Medium · High · M] `repair`/bootstrap hydrates all devices, conflicting with `device-namespace-partitioning` — `src/storage/index.ts:175`, `src/cli/index.ts:388`

- **Issue:** `bootstrapFromQdrant` scans every `bhgbrain_*` collection and upserts every point
  with no `device_id` predicate (`src/storage/index.ts:180-194`); the CLI `repair --from-qdrant`
  exposes no device flag (`src/cli/index.ts:376-391`). The `device-namespace-partitioning`
  proposal explicitly specifies that "the `repair` tool uses `device_id` to selectively recover
  only the current device's memories, or all memories with `--all-devices`"
  (`openspec/changes/device-namespace-partitioning/proposal.md:18`). `new-device-bootstrap`
  lists per-device filtering as a Non-Goal (`proposal.md:39`), so the two changes give the
  `repair` surface contradictory contracts.
- **Why it matters:** A user who configured a distinct `device_id` would expect `repair` to
  scope to their device per the partitioning spec; the current implementation silently pulls in
  other devices' memories. The naming overlap ("repair") makes the divergence easy to miss.
- **Recommendation:** Reconcile the two proposals: either add an optional `device_id` filter
  (defaulting to current `config.device.id`, with `--all-devices` to override) to
  `bootstrapFromQdrant` and the CLI, or amend `device-namespace-partitioning` to delegate the
  unfiltered hydration to this command and rename one of them to remove the contract ambiguity.

### [Low · Low · S] CLI `repair` subcommand name collides with the `repair` MCP tool — `src/cli/index.ts:377`

- **Issue:** The CLI registers a `repair` subcommand (`src/cli/index.ts:377`) while a `repair`
  MCP tool is independently registered (`src/tools/schemas.ts:156`, dispatched at
  `src/tools/index.ts:89`). They share a name but have different behavior and surfaces.
- **Why it matters:** Future readers and docs (`README.md` MCP Tools Reference) may conflate the
  two, and a user reading tool docs may expect the CLI flag set to match.
- **Recommendation:** Document the distinction explicitly, or align the CLI subcommand's
  semantics/flags with the MCP `repair` tool so the shared name reflects shared behavior.

## Testing & coverage

No issues found for the implemented scope. The 11 added tests cover insert-from-payload,
idempotency, defaults, epoch `expires_at` conversion, FTS population, hydration count, empty
collections, idempotency skip, logger passthrough, and both CLI paths
(`sqlite.test.ts:256-328`, `storage/index.test.ts:243-315`, `cli/index.test.ts:271-289`).

Coverage gap to note (tied to Finding 1, not a separate finding): there is no test exercising a
payload with an out-of-enum `type` (the CHECK-violation path), nor one asserting that a failed
main insert does not leave an orphan FTS row. Adding such a test would have caught Finding 1 and
should accompany its fix.

## Dependencies & supply chain

No issues found. The change introduces no new dependencies; it reuses existing
`@qdrant/js-client-rest` scroll APIs (`src/storage/qdrant.ts`), sql.js, and Pino. ESM `.js`
import extensions are used consistently across the touched files.

## Recommendations (prioritized)

1. **(High)** Fix `upsertMemoryFromPayload` (Finding 1): validate `type` against the enum,
   gate the FTS insert + `return true` on the main insert actually applying, and/or wrap both
   inserts in one transaction. Add a regression test for an out-of-enum `type` payload.
2. **(Medium)** Resolve the `repair`/device-filter drift (Finding 2) with
   `device-namespace-partitioning`: add an optional `device_id` scope (default current device,
   `--all-devices` override) or formally amend one proposal so the `repair` contract is single-sourced.
3. **(Low)** Stream hydration page-by-page to bound memory (Finding 3).
4. **(Low)** Make the "device empty" gate include archived rows (Finding 4).
5. **(Low)** Document or align the CLI `repair` vs MCP `repair` naming (Finding 5).
