# Code Audit — OpenSpec proposal `preserve-non-sliding-expiry`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `preserve-non-sliding-expiry`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 7 (`proposal.md`, `tasks.md`, `design.md`, `specs/non-sliding-expiry-preservation/spec.md`, `src/domain/lifecycle.ts`, `src/search/index.ts`, `src/storage/sqlite.ts`; cross-checks in `lifecycle.test.ts`, `search/index.test.ts`)

## Executive summary

The proposal is **not yet implemented** — every box in `tasks.md` is unchecked, and the code on the audited branch still exhibits the exact bug the proposal describes. The audit confirms the defect is real and data-affecting, not hypothetical.

Root cause is a value-overloading bug across two layers:

1. `MemoryLifecycleService.extendExpiry()` returns `null` when `sliding_window_enabled === false` (`src/domain/lifecycle.ts:122-125`). It uses `null` to mean two different things: "this tier has no TTL" and "do not extend the TTL." 
2. `SearchService.buildAccessUpdate()` forwards that `null` verbatim into the `AccessUpdate` (`src/search/index.ts:253,261`), so every read of a T2/T3 memory under non-sliding mode produces `expires_at: null`.
3. `recordAccessBatch()` honors a tri-state contract (`undefined` = leave column alone, `null` = write NULL) at `src/storage/sqlite.ts:675-678`. Because step 2 supplies `null` rather than `undefined`, the helper executes `expires_at = NULL`, **clearing the existing TTL on every read** for time-bounded memories whenever sliding windows are disabled.

The good news: the storage layer's tri-state contract (`expires_at?: string | null`) already exists and is correct, so the fix is concentrated in `extendExpiry`/`buildAccessUpdate` (return/propagate `undefined` for the no-change case). Severity is **High** because it silently turns bounded memories into non-expiring ones — a data-retention correctness regression — but the blast radius and fix effort are small.

No security, dependency, or performance regressions were found in the proposal's scope. The chief gaps are correctness (the unfixed bug) and the absence of the regression tests the proposal mandates.

## Spec compliance

| Requirement / Task | Status | Evidence |
|---|---|---|
| Req: Non-sliding access updates preserve existing expiry (unchanged tier) | **Missing** | `src/domain/lifecycle.ts:123` returns `null` for unchanged tier under non-sliding mode; `src/search/index.ts:261` propagates it; `src/storage/sqlite.ts:676-677` writes `expires_at = NULL`. Existing TTL is cleared, not preserved. |
| Req: Expiry-clearing semantics are explicit ("do not change" vs "clear") | **Drifted** | Storage layer already distinguishes the two via `undefined` vs `null` (`src/storage/sqlite.ts:675`, `AccessUpdate.expires_at?: string \| null` at `:21-28`). But lifecycle/search never emit `undefined` for no-change (`lifecycle.ts:122-125`, `search/index.ts:261`), so the explicit contract is undermined upstream. |
| Req: Promotion still applies tier lifecycle policy under non-sliding mode | **Missing** | On promotion, `buildAccessUpdate` still calls `extendExpiry(promotedTier, now)` (`src/search/index.ts:253`), which returns `null` when sliding is disabled — so a promoted T3→T2 memory also loses expiry instead of getting the promoted tier's recomputed TTL. The spec requires recomputation on promotion. |
| Task 1.1 Represent "preserve expiry" separately from "clear expiry" in types | **Missing** | `LifecycleMetadata.expires_at: string \| null` (`lifecycle.ts:15`) and `extendExpiry(): string \| null` (`lifecycle.ts:122`) still use bare `null`; no no-change sentinel introduced. |
| Task 1.2 Read-path assembly preserves expiry on unchanged tier, applies promoted policy | **Missing** | `src/search/index.ts:251-264` unchanged; no branch for unchanged-tier preservation vs promotion recompute. |
| Task 2.1 SQLite helpers honor no-change expiry without writing `null` | **Done (pre-existing)** | `recordAccessBatch` (`sqlite.ts:675`) and `recordAccess` (`sqlite.ts:630`) already skip the column when `expires_at === undefined`. Capability exists; callers just don't use it. |
| Task 2.2 Regression tests for unchanged-tier + promotion under `sliding_window_enabled = false` | **Missing** | `src/domain/lifecycle.test.ts:9` only sets `sliding_window_enabled: true`; no false-path test. `src/search/index.test.ts` asserts `recordAccessBatch` was called (`:88`) but never inspects the `expires_at` payload. |
| Task 3.1 Run lint/test/build | **Missing** | No implementation to validate; unchecked. |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
|---|---|---|---|---|---|---|
| 1 | High | High | S | Stability / correctness | `src/domain/lifecycle.ts:122-125` | `extendExpiry` returns `null` (clear) instead of no-change when sliding disabled |
| 2 | High | High | S | Stability / correctness | `src/search/index.ts:253,261` | Access-update forwards `null`, clearing TTL on every read; promotion path loses TTL too |
| 3 | Medium | High | S | Testing | `src/domain/lifecycle.test.ts:9`, `src/search/index.test.ts:88` | No coverage for `sliding_window_enabled=false`; the regression would pass CI undetected |
| 4 | Low | Medium | S | Maintainability | `src/domain/lifecycle.ts:15,122` | `string \| null` return type cannot express tri-state; invites recurrence elsewhere |
| 5 | Low | Medium | M | Stability / consistency | `src/search/index.ts:239` + Qdrant | Even after SQLite fix, Qdrant `expires_at` payload is not reconciled on access updates |

## Quick wins

- **Finding 1 + 2 (the fix itself):** change `extendExpiry` to return `undefined` (not `null`) for the no-change case, and have `buildAccessUpdate` pass that `undefined` straight through. The storage layer already does the right thing with `undefined`. This is a few lines and resolves the High-severity correctness bug.
- **Finding 3:** add two Vitest cases — unchanged-tier read preserves `expires_at`, and promotion recomputes it — both with `sliding_window_enabled: false`. These directly satisfy task 2.2 and lock the fix.

## Performance

No issues found. The access-update path already batches writes (`recordAccessBatch`, `src/storage/sqlite.ts:668-691`) and defers flush (`src/search/index.ts:240`). The fix does not add per-row work.

## Logging & observability

No issues found within the proposal scope. Note (informational, not a finding): TTL clearing happens silently — there is no Pino log when an access update mutates `expires_at`. This is consistent with the rest of the hot read path and adding logging there is out of scope; flagged only so the team is aware that the current bug leaves no audit trail.

## Stability & reliability

### [High · High · S] `extendExpiry` clears TTL instead of preserving it under non-sliding mode — `src/domain/lifecycle.ts:122-125`

**Issue:** 
```ts
extendExpiry(tier: RetentionTier, now: Date): string | null {
  if (this.config.retention?.sliding_window_enabled === false) return null;
  return this.computeExpiry(tier, now);
}
```
When sliding windows are disabled the method returns `null`. Downstream, `null` is interpreted by the storage layer as "write `expires_at = NULL`" (clear), but the intended semantic here is "do not extend / leave it as is." The proposal's design (`design.md:3,17-22`) names this `null`-overloading as the direct root cause.

**Why it matters:** Disabling sliding-window extension is meant to stop *lengthening* a deadline on access — not to *remove* the deadline. As written, the first read of any T2/T3 memory under a non-sliding retention policy strips its TTL, converting a time-bounded memory into a permanent one. That is a silent, data-affecting retention failure that defeats the operator's retention configuration.

**Recommendation:** Return `undefined` for the no-change case so it is distinct from a genuine "clear" (`null`) and a genuine "set" (`string`). Update the signature to `string | null | undefined` (or a tagged result). Keep returning a real timestamp only when sliding is enabled or when a tier legitimately has no TTL and you intend to clear it.

### [High · High · S] Access-update assembly propagates clear and mishandles promotion — `src/search/index.ts:253,261`

**Issue:**
```ts
const nextExpiry = this.lifecycle.extendExpiry(promotedTier, now);
...
expires_at: nextExpiry === null ? null : nextExpiry,
```
`buildAccessUpdate` forwards the `null` from finding 1 into the `AccessUpdate`, so `expires_at` is `null` (clear) rather than `undefined` (no-change) for unchanged-tier reads. Worse, on a real promotion (`promotedTier !== mem.retention_tier`), `extendExpiry` *also* returns `null` under non-sliding mode (because it short-circuits before `computeExpiry`), so the promoted tier's TTL is dropped — violating the spec requirement that promotion recompute expiry (`spec.md:21-28`).

**Why it matters:** This is the call site that actually corrupts stored data on the read path, on every matched memory (`recordAccessBatch` at `:239`). It breaks two of the three spec requirements simultaneously: preservation for unchanged tiers and recomputation on promotion.

**Recommendation:** Split the two cases explicitly:
- Unchanged tier under non-sliding mode → set `expires_at: undefined` (omit the column).
- Promotion (tier changed) → compute the promoted tier's TTL with `computeExpiry(promotedTier, now)` regardless of `sliding_window_enabled`, since promotion is a policy state change, not a sliding extension (per `design.md:29-32`).
- Sliding enabled, unchanged tier → existing extend behavior.

### [Low · Medium · M] Qdrant `expires_at` payload not reconciled with SQLite on access updates — `src/search/index.ts:239`

**Issue:** `recordAccessBatch` updates only SQLite. Qdrant stores `expires_at` as an epoch payload (`src/storage/qdrant.ts:153-154`, `src/storage/index.ts:330`) used for filter pruning. After the fix, SQLite and Qdrant `expires_at` can diverge for promoted memories whose TTL is recomputed on access, since the vector payload is not re-synced in this path.

**Why it matters:** Divergence is low-impact for the unchanged-tier case (no value changes) but could let Qdrant pre-filtering and SQLite expiry disagree for promotion-driven recomputes. This is a pre-existing consistency gap that the fix slightly widens, not introduces.

**Recommendation:** Out of scope for this proposal (the spec targets SQLite preservation). Note it for a follow-up: either mark the vector for re-sync on tier promotion or document that Qdrant `expires_at` is best-effort and SQLite is authoritative.

## Security

No issues found. The change touches retention timestamps only; no auth, input-validation, secret-handling (`*_api_key_env`), or network-binding surface is affected.

## Maintainability & code quality

### [Low · Medium · S] `string | null` return type cannot express the tri-state contract — `src/domain/lifecycle.ts:15,122`

**Issue:** `LifecycleMetadata.expires_at` and `extendExpiry`'s return type are `string | null`, with no type-level way to express "no change." The whole bug stems from overloading `null`. `design.md:45-47` raises this as an open question (use `undefined` vs a tagged value).

**Why it matters:** A bare `string | null` makes the same misuse easy to reintroduce in any future caller of lifecycle helpers. The compiler offers no guardrail.

**Recommendation:** Adopt the proposal's option: represent no-change as `undefined` (cheapest, aligns with the existing `recordAccessBatch` `=== undefined` check) or a small tagged union (`{ kind: 'keep' } | { kind: 'clear' } | { kind: 'set', value: string }`) if compile-time safety against misuse is desired. Whichever is chosen, apply it consistently across `extendExpiry`, `AccessUpdate.expires_at`, and the SQLite helpers.

## Testing & coverage

### [Medium · High · S] No regression coverage for `sliding_window_enabled = false` — `src/domain/lifecycle.test.ts:9`, `src/search/index.test.ts:88`

**Issue:** `lifecycle.test.ts` hard-codes `sliding_window_enabled: true` (`:9`), so `extendExpiry`'s false branch — the exact bug locus — is never exercised. `search/index.test.ts` asserts only that `recordAccessBatch` was *called* (`:88`); it never inspects the `expires_at` field of the emitted `AccessUpdate`, so TTL clearing is invisible to the suite. Task 2.2 explicitly requires these tests and they are absent.

**Why it matters:** The current bug ships green. Without a test asserting `expires_at` is preserved (unchanged tier) and recomputed (promotion) under non-sliding mode, the fix cannot be verified and the behavior can silently regress again.

**Recommendation:** Add: (a) a `lifecycle` test with `sliding_window_enabled: false` asserting `extendExpiry` signals no-change; (b) a `SearchService` test that pre-seeds a T2 memory with a fixed `expires_at` and asserts the captured `recordAccessBatch` argument leaves `expires_at` undefined/unchanged; (c) a promotion test (access count crossing `auto_promote_access_threshold`) asserting the promoted tier's recomputed TTL is written even with sliding disabled.

## Dependencies & supply chain

No issues found. The change is confined to first-party `src/` files and introduces no new runtime or dev dependencies. No version bump to `package.json` is implied beyond the user-visible-behavior convention noted in `CLAUDE.md`.

## Recommendations (prioritized)

1. **Implement the fix (Findings 1 & 2, High).** Make `extendExpiry` return `undefined` for no-change; in `buildAccessUpdate`, preserve (`undefined`) on unchanged tier and recompute (`computeExpiry(promotedTier, now)`) on promotion regardless of sliding mode. Satisfies all three spec requirements and tasks 1.1/1.2.
2. **Add the regression tests (Finding 3, Medium).** Unchanged-tier preservation, promotion recompute, and the `extendExpiry` false branch — all under `sliding_window_enabled: false`. Satisfies task 2.2 and prevents recurrence.
3. **Harden the type contract (Finding 4, Low).** Replace `string | null` no-change overloading with `undefined` or a tagged value across lifecycle/storage helpers. Resolves the `design.md` open question and forecloses re-misuse.
4. **Run lint/test/build (task 3.1)** once 1–3 land.
5. **Track the Qdrant payload divergence (Finding 5, Low)** as a separate follow-up; out of scope for this proposal but worth a note so SQLite-vs-vector expiry consistency is owned.
