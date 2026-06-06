# Code Audit — OpenSpec proposal `device-namespace-partitioning`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `device-namespace-partitioning`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 13 (`proposal.md`, `tasks.md`, `design.md`, `src/config/index.ts`, `src/domain/types.ts`, `src/domain/schemas.ts`, `src/storage/sqlite.ts`, `src/storage/qdrant.ts`, `src/storage/index.ts`, `src/pipeline/index.ts`, `src/search/index.ts`, `src/tools/index.ts`, `src/tools/schemas.ts`, plus `src/tools/import.ts`, `src/tools/bootstrap.ts`, `src/storage/sqlite.test.ts`, `README.md`, `.env.example`)

## Executive summary

The feature is substantially implemented and wired end-to-end: `device_id` is resolved from config/env/hostname, persisted, threaded through the write pipeline, stored in both SQLite and Qdrant, surfaced in search results, and used as a repair filter. Type-checking and ESLint pass cleanly, and user-facing docs (README, `.env.example`) are in sync. The headline risk is a **migration gap**: the Qdrant `device_id` keyword index is only created for brand-new collections, so the proposal's explicit promise of "one-time payload index creation on existing collections" does not hold — existing Qdrant Cloud collections (the exact multi-device scenario that motivated this change) never get the index. A secondary correctness concern is that exact-checksum dedup remains a local-SQLite lookup, so the proposal's "prevent cross-device duplicates" goal is only partially met. Test coverage for the new logic is thin (one round-trip assertion; no tests for resolution, repair filtering, or index creation). No security isolation regressions were found — this is additive provenance tagging, not access control, consistent with the stated non-goals.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| `device` config section with regex-validated optional `id` (Task 1) | Done | `src/config/index.ts:18-20`, `DEVICE_ID_RE` at `src/config/index.ts:6` |
| `resolveDeviceId(config)` priority chain config → env → hostname (Task 1) | Done | `src/config/index.ts:265-279`; sanitize at `:248-255` |
| Persist resolved `device_id` to config.json on first run (Task 1) | Drifted | `src/config/index.ts:287-291` — writes config.json **unconditionally on every startup**, not only "if not already set"; rewrites/expands the user file each boot |
| `device_id` added to `MemoryRecord` and `SearchResult` (Task 2) | Done | `src/domain/types.ts:48`, `:79` |
| `device_id TEXT` column migration in `ensureMemoryColumns()` (Task 3) | Done | `src/storage/sqlite.ts:1319`; DDL also at `:158` |
| `device_id` in `insertMemory`, `rowToMemory`, `updateMemory` (Task 3) | Done | insert `:340/345/369`, payload-insert `:393/417/423`, `rowToMemory` `:1199`, `updateMemory` generic loop `:434-456` |
| `device_id` keyword index in `ensureCollection()` (Task 4) | Partial / Drifted | `src/storage/qdrant.ts:69-72` — created **only inside the collection-not-found `catch`** (`:42-73`); existing collections never indexed, contradicting proposal `:35` and design `:111` |
| Thread `device_id` through write path (Task 5) | Done | pipeline input `src/pipeline/index.ts:39`, ADD `:213`, fallback `:298`; storage payload `src/storage/index.ts:317/331`, upsert `:34` |
| `remember` handler passes `ctx.config.device.id` (Task 5/8) | Done | `src/tools/index.ts:107`; also import `src/tools/import.ts:111`, bootstrap `src/tools/bootstrap.ts:115` |
| `device_id` in search results incl. Qdrant-fallback (Task 6) | Done | SQLite path `src/search/index.ts:232`, Qdrant fallback `:204` |
| `RepairInputSchema` optional `device_id` (Task 7) | Done | `src/domain/schemas.ts:87` |
| Repair MCP schema `device_id` filter description (Task 7) | Done | `src/tools/schemas.ts:162` |
| `handleRepair` filters by `device_id`; falls back to local id on recovery (Task 7) | Done | `src/tools/index.ts:283-284`, filter `:314-319`, fallback `:347-348/371` |
| Build compiles cleanly; lint passes (Task 9) | Done | `npm run lint` (tsc --noEmit + eslint) passes with no errors |
| `npm test` all pass / manual device_id verification (Task 9) | Partial | Only one assertion exercises the field (`src/storage/sqlite.test.ts:268/284`); no tests for resolution, repair filtering, search passthrough, or index creation |
| Proposal: dedup checksum lookups namespace-scoped to prevent cross-device duplicates | Partial | `src/pipeline/index.ts:110` `getMemoryByChecksum` is a **local SQLite** lookup; Device B cannot see Device A's checksums, so exact-dedup cannot prevent cross-device dupes (only Qdrant near-dedup at `:133` may) |
| Proposal: `repair` supports `--all-devices` | Drifted | Implemented as "omit `device_id` ⇒ all devices" (`src/tools/index.ts:316`); no explicit `--all-devices`/`all_devices` flag, but behavior is equivalent |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | High | High | S | Stability | `src/storage/qdrant.ts:38-73` | `device_id` index only created for new collections; migration on existing collections never runs |
| 2 | Medium | High | M | Stability | `src/pipeline/index.ts:110` | Exact-checksum dedup is local-only, so cross-device duplicate prevention goal is unmet |
| 3 | Medium | High | S | Maintainability | `src/config/index.ts:287-291` | config.json rewritten unconditionally on every startup; strips comments, drifts from "if not already set" spec |
| 4 | Medium | Medium | S | Testing | `src/storage/sqlite.test.ts:268` | New logic (resolution, repair filter, index, search passthrough) effectively untested |
| 5 | Low | High | S | Maintainability | `src/config/index.ts:266-274` | Persisted `device.id` silently overrides `BHGBRAIN_DEVICE_ID`, contradicting the "env takes precedence" comment at `:196-197` |
| 6 | Low | Medium | S | Performance | `src/tools/index.ts:305-319` | Repair filters `device_id` client-side after `scrollAll`; the new Qdrant index is unused, so the index's perf rationale is not realized |
| 7 | Low | Medium | S | Maintainability | `src/config/index.ts:248-254` | `sanitizeDeviceId` slices to 64 chars *after* trimming hyphens, so truncation can re-introduce a trailing `-` |

## Quick wins

- Move the `device_id` payload-index creation out of the `catch` block so it runs (idempotently) for existing collections (#1).
- Gate the config.json write on an actual change, e.g. only persist when `resolveDeviceId` had to synthesize an id (#3).
- Add unit tests for `resolveDeviceId`/`sanitizeDeviceId` and a repair device-filter test (#4).

## Performance

### [Low · Medium · S] Repair device filter does not use the new Qdrant index — `src/tools/index.ts:305-319`
**Issue:** `handleRepair` calls `scrollAll(collectionName)` to pull every point, then filters `device_id` in memory (`:315-319`). The `device_id` keyword index added by this proposal (`src/storage/qdrant.ts:69-72`) is never used for server-side filtering.
**Why it matters:** For large Qdrant collections, scrolling all points to recover one device's memories transfers and deserializes the full corpus, defeating the "efficient per-device filtering" justification in proposal `:15`. The index currently buys nothing operationally.
**Recommendation:** When `device_id` is provided, use a Qdrant scroll/filter with a `must` keyword match on `device_id` so the server prunes points. Keep the in-memory check as a guard. This also makes the new index load-bearing.

## Logging & observability

No issues found. The repair handler returns structured counters (`points_scanned`, `skipped_device_filter`, `recovered`, `errors`) and accumulates per-point errors rather than swallowing them (`src/tools/index.ts:298-301`, `:380-382`). No secrets or PII are logged by the new code paths; `device_id` is non-sensitive provenance.

## Stability & reliability

### [High · High · S] `device_id` Qdrant index is never created on existing collections — `src/storage/qdrant.ts:38-73`
**Issue:** `ensureCollection` calls `getCollection(name)` and only enters the `catch` branch — where all `createPayloadIndex` calls live, including `device_id` (`:69-72`) — when the collection does **not** exist. For any collection that already exists (the normal case after upgrade), the function returns immediately at `:41` and no index is created.
**Why it matters:** Proposal `:35` and design `:111` explicitly promise the `device_id` index is created "on existing collections (handled by `ensureCollection` on startup)". This is the precise migration path for the multi-device Qdrant Cloud setup that motivated the change. As written, existing deployments never get the index, so any future server-side `device_id` filtering will silently fall back to unindexed (slow / potentially rejected) filtering, and the documented migration is a no-op.
**Recommendation:** After the `try/catch`, unconditionally call `createPayloadIndex` for `device_id` (and ideally the other indexes), tolerating an "already exists" error. Qdrant `createPayloadIndex` is effectively idempotent; wrap in a try/catch that ignores the conflict. Add a test asserting the index is created when the collection already exists.

### [Medium · High · M] Exact-checksum dedup is local-only, so cross-device duplicate prevention is unmet — `src/pipeline/index.ts:110`
**Issue:** The first dedup step calls `this.storage.sqlite.getMemoryByChecksum(namespace, checksum)` — a lookup against the *local* SQLite store. The proposal's premise (`:5-6`) is that Device B's SQLite is empty for Device A's memories. Therefore the exact-checksum branch can never match a memory authored on another device, and the proposal's stated goal "Dedup checksum lookups remain namespace-scoped … to prevent cross-device duplicates" (`:30`) is only partially achievable.
**Why it matters:** Two devices writing identical content to the same namespace will both pass the exact-dedup gate. They are only deduped if the Qdrant near-dedup step (`:133`, requires a successful embedding) catches them; in the embedding-failure fallback (`:127`, `:249-305`) there is no Qdrant check at all, so a duplicate is written unconditionally. The "write collisions" problem the proposal set out to solve is thus not fully closed.
**Recommendation:** Either (a) document this as a known limitation and rely on Qdrant near-dedup, or (b) add a checksum payload index in Qdrant and perform a namespace-scoped checksum lookup against Qdrant before ADD, so dedup is store-of-record-based rather than local-replica-based. At minimum, add the checksum check to the deterministic fallback path.

## Security

No issues found. This change is additive provenance tagging and explicitly not access control (proposal Non-Goals `:43`); it introduces no new namespace-isolation surface. `device_id` is validated by Zod regex on the config (`src/config/index.ts:19`), the env path (`:271`), the repair input (`src/domain/schemas.ts:87`), and the MCP schema `pattern` (`src/tools/schemas.ts:162`), so it cannot inject arbitrary strings into Qdrant filters or SQL. SQLite writes are parameterized (`src/storage/sqlite.ts:341-374`). No cross-namespace leakage is introduced: namespace scoping in search/storage is unchanged by this proposal.

## Maintainability & code quality

### [Medium · High · S] config.json is rewritten on every startup — `src/config/index.ts:287-291`
**Issue:** `ensureDataDir` calls `resolveDeviceId` then **always** `writeFileSync(configPath, JSON.stringify(config, …))`. Task 1 specifies persisting the resolved id "if not already set", but the code writes unconditionally, every boot, for both CLI (`src/cli/index.ts:22`) and server (`src/index.ts:40`) entry points.
**Why it matters:** It serializes the fully Zod-defaulted config back to disk, stripping any user comments/formatting and expanding every default into the file on first run after upgrade. It is also an avoidable disk write on each start and can surprise users who hand-maintain config.json.
**Recommendation:** Track whether `resolveDeviceId` actually synthesized an id (return a boolean or compare before/after), and only write when the file is missing or `device.id` was newly assigned.

### [Low · High · S] Persisted `device.id` silently overrides `BHGBRAIN_DEVICE_ID` — `src/config/index.ts:266-274`
**Issue:** `resolveDeviceId` returns `config.device.id` first (`:266-267`), before consulting `BHGBRAIN_DEVICE_ID` (`:270`). Because the resolved id is persisted to config.json (#3), after the first run the env var is permanently ignored. This is intentional for stability but directly contradicts the comment "Env vars take precedence over file-based config — the expected behavior when running inside a Docker container" at `:196-197` and the `.env.example` framing of `BHGBRAIN_DEVICE_ID` as an override.
**Why it matters:** A Docker/W365 operator setting `BHGBRAIN_DEVICE_ID` to re-home an instance will find it has no effect once a config.json exists, which is the opposite of the documented contract for the other `BHGBRAIN_*` vars.
**Recommendation:** Either honor `BHGBRAIN_DEVICE_ID` ahead of a persisted file value (and re-persist), or update README/`.env.example`/the precedence comment to state explicitly that `device.id`, once persisted, wins over the env var.

### [Low · Medium · S] `sanitizeDeviceId` can re-introduce a trailing hyphen after truncation — `src/config/index.ts:248-254`
**Issue:** The chain trims leading/trailing hyphens (`.replace(/^-|-$/g, '')`) and *then* `.slice(0, 64)`. If a sanitized hostname is exactly 65+ chars and char 64 is followed by a `-`, or the slice lands mid-token, the result can end in `-`. The value still matches `DEVICE_ID_RE`, so it is valid, but it is cosmetically inconsistent with the intent.
**Why it matters:** Minor; only affects very long hostnames. Worth a one-line fix for correctness.
**Recommendation:** Reorder to slice first, then strip trailing hyphens: `….slice(0, 64).replace(/-+$/,'') || 'unknown'`.

## Testing & coverage

### [Medium · Medium · S] New device logic is effectively untested — `src/storage/sqlite.test.ts:268`
**Issue:** The only test touching the feature asserts `device_id` survives an `upsertMemoryFromPayload` round-trip (`:268`, `:284`). There are no tests for: `resolveDeviceId` priority chain or `sanitizeDeviceId`; the env-vs-persisted precedence; repair `device_id` filtering and the "fall back to local id" recovery branch (`src/tools/index.ts:347-348`); search `device_id` passthrough including the Qdrant-fallback path (`src/search/index.ts:204`); and Qdrant index creation (which is also where finding #1 hides).
**Why it matters:** The two correctness risks in this audit (the index-migration gap #1 and the env-precedence surprise #5) are exactly the kind of behavior a unit test would have pinned. Task 9 also calls for verifying `device_id` appears in both stores, which no automated test currently does.
**Recommendation:** Add focused unit tests: (1) `resolveDeviceId` with explicit id / env / hostname and with a pre-persisted id; (2) `sanitizeDeviceId` edge cases; (3) a repair test seeding two devices' points and asserting the filter selects only one and recovers with the correct `device_id`; (4) a Qdrant `ensureCollection` test (or mock) asserting the `device_id` index is created for an already-existing collection.

## Dependencies & supply chain

No issues found. The change adds no new dependencies; it uses only `node:os` `hostname` (`src/config/index.ts:4`), existing `zod`, the existing `@qdrant/js-client-rest`, and sql.js. No version ranges were altered for this feature.

## Recommendations (prioritized)

1. **Fix the Qdrant index migration (#1, High/S).** Create the `device_id` payload index idempotently outside the collection-not-found branch so existing collections are migrated as the proposal promises. Add a regression test.
2. **Resolve the dedup/precedence contradictions (#2, #5, Medium-Low).** Decide and document whether cross-device exact-dedup is in scope; if so, back checksum dedup with Qdrant. Reconcile `BHGBRAIN_DEVICE_ID` precedence with the documented "env wins" contract (fix code or fix docs).
3. **Stop rewriting config.json every boot (#3, Medium/S).** Persist only when an id was newly synthesized or the file is absent.
4. **Add tests for resolution, repair filtering, search passthrough, and index creation (#4, Medium/S).**
5. **Optionally push the repair filter server-side (#6) and tidy `sanitizeDeviceId` truncation (#7) — low-priority polish.**
