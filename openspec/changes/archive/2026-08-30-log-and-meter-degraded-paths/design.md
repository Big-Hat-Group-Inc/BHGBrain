## Context

The project's design Decision 3 (from `address-codereview-issues`) states the system should "prioritize fail-safe semantics over silent degradation." The fail-closed HTTP auth path honors this with a high-visibility warning (`src/transport/middleware.ts:160`). Several other degraded/failure paths do not, and three separate audits independently flagged the same anti-pattern:

- `preserve-metadata-in-degraded-writes-2026-06-05-02-19.md` (findings L-1, L-2): the embedding failure that triggers a degraded metadata-only write is swallowed with no Pino log or metric (`src/pipeline/index.ts:125-130`); `writeMemoryWithoutVector` increments no degraded-write counter.
- `address-codereview-issues-2026-06-05-02-19.md` (finding 2): degraded-embedding startup is silent, contradicting Decision 3 (`src/index.ts`).
- `refactor-retention-sqlite-boundary-2026-06-05-02-19.md` (finding 2): retention/GC runs emit no Pino logs despite mutating persistent state (`src/backup/retention.ts`).

This proposal owns the degraded-path observability gaps that are **not** already covered by other proposals, so the "no silent degradation" rule is applied consistently from one place.

## Goals / Non-Goals

**Goals:**
- A degraded (metadata-only) write emits a structured Pino warning and increments a degraded-write metric.
- Starting in a degraded embedding mode emits a structured Pino startup warning.
- Retention/GC runs emit a structured Pino summary (counts, outcome).
- Centralize the rule so degraded conditions are never silent.

**Non-Goals:**
- Hybrid-search degradation visibility (owned by the sibling search/observability proposals).
- Circuit-breaker open/half-open logging (owned by `add-circuit-breakers` / `harden-circuit-breaker-half-open-and-logging`).
- Vector GC failure visibility (owned by `batch-retention-and-vector-cleanup`).
- Changing degraded-mode behavior itself (when fallback is taken, what is persisted, or startup policy) — only its observability.
- Building dashboards/alerts; this proposal emits the signals they would consume.

## Decisions

1. This proposal is the single owner of degraded-path observability.
- The "no silent degradation" rule is applied consistently here rather than re-litigated per change. Sibling proposals that own hybrid-search, circuit-breaker, and vector-GC failure visibility are referenced, not duplicated; this change explicitly excludes those paths.

2. Degraded **writes** get both a log and a metric.
- A `warn`-level Pino log captures the one-time transition signal (event, namespace, collection, embedding error); a `degraded_writes_total` metric captures the rate/backlog trend for dashboards. A log alone cannot drive a rate alert; a metric alone loses the causal error.

3. Degraded **startup** gets a `warn` log, matching the fail-closed auth path.
- The degraded flag is already exposed by the provider factory (`degraded = true`); plumb it into `main()` and warn once at startup. No metric is required for a one-shot startup condition.

4. Retention/GC runs get a structured **summary** log.
- One `info` summary per run with counts (stale-marked, scanned, archived, deleted) and outcome. SQLite audit-log rows already exist but are not operational logs; the Pino summary closes the operational-visibility gap without changing retention behavior.

5. Reuse existing infrastructure.
- Use the project's Pino logger and `health/metrics` module rather than introducing new logging or metric primitives.

## Risks / Trade-offs

- [Log/metric noise during a prolonged embedding outage] -> Mitigation: warn (not error) at the transition; rely on the metric for rate, and keep the per-write log at a level that can be sampled if needed.
- [Threading a logger into `WritePipeline` touches its constructor/wiring] -> Mitigation: inject via the existing context/wiring used elsewhere; keep the change additive and behavior-preserving.
- [Scope creep into sibling-owned degraded paths] -> Mitigation: Decision 1 explicitly fences this proposal to write-fallback, startup, and retention only.

## Migration Plan

- Inject the Pino logger into `WritePipeline` and add the degraded-write warning at the fallback point.
- Add the degraded-write metric increment in the storage degraded-write path.
- Plumb the degraded-startup flag into `main()` and emit the startup warning.
- Add the retention/GC run summary log.
- Add tests, then run `npm run lint`, `npm test`, and `npm run build`.
- No data migration; changes are observability-only and backward compatible.

## Open Questions

- Should the per-write degraded log be `warn` on the first transition only and `debug` thereafter, or `warn` on every degraded write? (Default: `warn` per write, revisit if noisy.)
- Should the degraded-write metric be a counter (`degraded_writes_total`) only, or also a gauge fed by `countUnsyncedVectors()` for backlog size? (Default: counter; gauge optional.)
- Should retention emit one combined summary or one line per phase (markStale / runGc / runConsolidation)? (Default: one structured line per phase.)
