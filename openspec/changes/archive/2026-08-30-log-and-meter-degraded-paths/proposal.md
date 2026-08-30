## Why

The codebase states a "no silent degradation" design rule (design Decision 3 of `address-codereview-issues`: "prioritize fail-safe semantics over silent degradation"), yet several failure/degraded paths swallow their condition with no Pino log and no metric. Three recurring audit findings expose this:

- The embedding failure that triggers a degraded **write** (metadata-only fallback) is caught and discarded with no log or metric, so a deployment can silently enter degraded mode and accumulate unsynced rows with no operational signal (`src/pipeline/index.ts:125-130`).
- Degraded-embedding **startup** works but emits no warning, directly contradicting the "no silent degradation" rule that the fail-closed HTTP auth path already honors (`src/index.ts`).
- Retention/GC runs mutate persistent state (mark stale, delete) but emit no Pino log, so an operator cannot tell what a run did without instrumenting callers (`src/backup/retention.ts`).

This proposal is the single owner of degraded-path observability, applying the rule consistently across these gaps. It does not re-cover hybrid-search degradation, circuit-breaker visibility, or vector GC failure visibility, which sibling proposals already own.

## What Changes

- Emit a structured Pino warning log AND increment a degraded-write metric when an embedding failure causes a degraded (metadata-only) write fallback.
- Emit a structured Pino startup warning when the server starts in a degraded embedding mode (e.g. missing credentials selecting the degraded provider).
- Emit a structured Pino summary log for each retention/GC run, reporting counts and outcome.
- Establish degraded-path observability as a consistently-applied, single-owner rule; reference (do not duplicate) the sibling proposals that own hybrid-search/breaker/GC failure visibility.

## Capabilities

### New Capabilities
- `degraded-path-observability`: Every failure/degraded path emits a structured Pino log and, where a rate matters, a metric — no degraded condition is silent.

### Modified Capabilities

(none)

## Impact

- Affected code: `src/pipeline/index.ts` (degraded-write fallback), `src/storage/index.ts` (degraded-write metric), `src/index.ts` (degraded startup warning), `src/backup/retention.ts` (retention/GC run summary).
- Operability: degraded mode and retention activity become observable in logs and dashboards, turning silent failure modes into alertable ones.
- No change to data model, transport, or public tool contracts.
