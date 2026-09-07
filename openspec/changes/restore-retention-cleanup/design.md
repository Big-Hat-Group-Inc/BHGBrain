## Context

The retention service owns a process-local lifecycle operation while its SQLite mutators independently reject all mutations during any lifecycle operation. Cleanup selection is synchronous and unbounded, schedulers accept unchecked cron strings, and archive/revision state is not retry-safe. See `proposal.md` and `specs/retention-cleanup-safety/spec.md`.

## Goals / Non-Goals

**Goals:**
- Make lifecycle ownership explicit at every cleanup mutation boundary.
- Bound each pass and make partial progress observable and resumable.
- Preserve real dependency failures and make schedule failure impossible to miss.

**Non-Goals:**
- Changing tier eligibility, default TTLs, or retention policy meaning.
- Replacing the existing cron scheduler or SQLite archive model.

## Decisions

1. Pass an unforgeable cleanup operation token through authorized mutators.
- The store will issue a token when `beginLifecycleOperation('gc')` succeeds; only calls carrying that token can bypass the mutation guard.
- A public boolean bypass was considered and rejected because unrelated call sites could accidentally disable exclusion.

2. Page by `(expires_at, id)` under both row and elapsed-time budgets.
- The result will include scanned, archived, deleted, unreconciled, remaining, and continuation fields.
- One unbounded query followed by batched deletes was rejected because it still materializes the corpus and blocks the event loop.

3. Validate cron syntax and satisfiability in the configuration schema.
- Scheduler instances will also retain `armed`, `last_run`, and `failure` state for health in case runtime scheduling still fails.
- Falling back silently to a default schedule was rejected because it hides operator intent.

4. Make archive identity unique by memory ID and allocate revisions with `MAX(revision) + 1` inside the owning transaction.
- A migration will deduplicate existing archive rows before adding the uniqueness constraint.
- Row count was rejected as a revision allocator because pruning makes it non-monotonic.

5. Treat collection-info failure as an explicit skip.
- Only confirmed not-found yields no collection information; other causes propagate to per-collection cleanup reporting.
- Defaulting failures to zero remaining points was rejected because it produces false compaction ratios.

## Risks / Trade-offs

- [Long backlogs need multiple passes] -> Persist/report continuation and schedule the next bounded pass normally.
- [Operation tokens touch several store APIs] -> Keep the token internal to retention/storage and cover allowed and rejected mutations with real-store tests.
- [Archive uniqueness migration finds conflicting rows] -> Keep the newest valid row deterministically and log the removed duplicate count.

## Migration Plan

1. Add archive deduplication and uniqueness migration plus monotonic revision allocation.
2. Add lifecycle ownership and paged selection APIs, then migrate `runGc`.
3. Add schema validation and scheduler health state.
4. Enable new failure logging/metrics and run a dry cleanup before the first destructive scheduled pass.
5. Roll back application code only after retaining the forward-compatible schema additions.
