## Context

The lifecycle service currently uses `null` to mean both “this tier has no expiry” and “do not extend expiry because sliding windows are disabled.” The search access-update path then writes that `null` back to storage, which can clear an existing `expires_at` value for T2/T3 memories. This is a small code change but an important lifecycle contract correction because it changes retention outcomes.

## Goals / Non-Goals

**Goals:**
- Preserve existing expiry values when access tracking runs with sliding-window extension disabled.
- Keep access-count and last-accessed updates working regardless of sliding-window policy.
- Continue to support explicit expiry recalculation when tier changes or policy intentionally removes expiry.

**Non-Goals:**
- Changing promotion thresholds or the overall retention tier model.
- Reworking unrelated search ranking or hydration logic.
- Introducing new retention configuration flags.

## Decisions

1. Distinguish “preserve existing expiry” from “clear expiry.”
- Decision: lifecycle and storage update contracts will use a no-change state distinct from explicit `null`.
- Rationale: current `null` overloading is the direct source of the bug.
- Alternative considered: special-case the bug only in `SearchService`. Rejected because the ambiguous contract would remain easy to misuse elsewhere.

2. Non-sliding access updates preserve expiry unless policy actually changes the tier outcome.
- Decision: when `sliding_window_enabled` is `false` and a memory remains in the same tier, access tracking updates counters and timestamps without modifying `expires_at`.
- Rationale: disabling sliding windows means do not extend the deadline on access, not remove the deadline entirely.
- Alternative considered: freeze all lifecycle fields, including promotion effects. Rejected because access-driven promotion can legitimately change lifecycle policy.

3. Tier promotion may still recalculate expiry under non-sliding mode.
- Decision: if an access update promotes a memory into a new tier, expiry is recomputed for the promoted tier even when sliding-window extension is otherwise disabled.
- Rationale: promotion is a policy state change, not a sliding extension of the previous tier's TTL.
- Alternative considered: preserve the prior expiry even on promotion. Rejected because it would make the promoted tier metadata internally inconsistent.

## Risks / Trade-offs

- [Tri-state expiry update semantics add a little complexity to storage helpers] -> Mitigation: keep the contract explicit and cover it with targeted tests.
- [Promotion behavior under non-sliding mode may surprise operators if undocumented] -> Mitigation: make the requirement explicit in specs and tests.

## Migration Plan

1. Update lifecycle helpers to return an explicit no-change state for expiry when sliding windows are disabled and tier is unchanged.
2. Update access-update assembly and SQLite write helpers to preserve expiry on no-change inputs.
3. Add regression tests for unchanged-tier access and promotion-driven access under non-sliding mode.

## Open Questions

- Should the implementation represent “no expiry change” with `undefined`, or should it introduce a more explicit tagged value to make misuse impossible at compile time?
