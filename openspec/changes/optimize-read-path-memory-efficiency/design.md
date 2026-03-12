## Context

Search currently resolves result IDs and then calls `getMemoryById()` per hit. Access metadata is updated per result. Auto-inject eagerly loads and concatenates all category content before enforcing `max_chars`.

## Goals / Non-Goals

**Goals:**
- Replace N+1 hydration with bulk row lookup.
- Bound write amplification caused by read traffic.
- Assemble inject payloads incrementally within a character budget.

**Non-Goals:**
- Changing ranking semantics.
- Removing access metadata entirely.

## Decisions

1. Add bulk hydration APIs for search.
- Search requests fetch the needed memories in one SQLite query and preserve ranking order in memory.

2. Keep access persistence bounded.
- Read traffic may still record access, but persistence is batched or sampled rather than causing per-hit write pressure.

3. Assemble inject payloads budget-first.
- The resource builder appends content only while budget remains and can prefer previews or summaries when large category bodies would exceed the limit.

## Risks / Trade-offs

- [Bulk hydration requires order restoration after SQL fetch] -> Mitigation: preserve external ranking in the service layer.
- [Sampling access metadata changes exact counts] -> Mitigation: choose deterministic batching if exact counts are required.

## Migration Plan

- Add bulk SQLite lookup methods.
- Update search services to use them.
- Refactor auto-inject assembly around remaining-budget checks.
