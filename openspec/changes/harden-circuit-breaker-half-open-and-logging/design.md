## Context

`add-circuit-breakers` is implemented and well-tested, but a follow-up code audit (`codeaudit/add-circuit-breakers-2026-06-05-02-19.md`) surfaced three net-new behavioral findings against the original `design.md`:

- **Half-open thundering herd (F2).** `design.md` states "One probe call is allowed." The implementation only fast-fails when `state === 'open'` (`src/resilience/circuit-breaker.ts:27-42`); in `half-open` every concurrent caller runs `fn()`. When the open window elapses under load, a burst of queued requests all hit the still-recovering dependency at once — the exact thundering herd the breaker is meant to prevent.
- **No transition logging (F1).** `open()`, `close()`, and `transitionToHalfOpenIfReady()` mutate state silently (`src/resilience/circuit-breaker.ts:91-102`); there is no Pino logging anywhere in `src/resilience/`. Degradation onset/recovery is only discoverable by actively polling `/health`.
- **Azure per-attempt failure inflation (F3).** The Azure provider wraps `executeSingleRequest`, which runs once per retry attempt (`src/embedding/azure-foundry.ts:110-185`). One `embedBatch` that retries up to `retry.max_attempts` times records that many breaker failures, tripping faster than `failure_threshold` logical calls implies and diverging from the OpenAI provider (which has no retry loop).

A minor doc-only finding (F6) — `QdrantStorage` vs the actual `QdrantStore` class — is also folded in as a documentation fix.

## Goals / Non-Goals

**Goals:**
- Restore the single-canary Half-Open semantic: exactly one trial request is admitted while a probe is in flight; concurrent callers fast-fail.
- Emit structured Pino logs on every breaker state transition with the breaker key and from/to state.
- Make one logical `embedBatch` record at most one breaker failure for the Azure provider, matching the OpenAI provider and the documented consecutive-failure semantic.
- Keep error types, config schema, and `/health` shape unchanged.

**Non-Goals:**
- Reworking the side-effecting `getState()` / polling-driven half-open transition (F4) — out of scope for this change.
- Changing `getStats().failures` reset behavior (F5).
- Extending breaker coverage to `searchSimilar`/`scrollAll`/`deleteMany` (F7) or splitting `ensureCollection` accounting (F8).
- Adding distributed/persistent breaker state or windowed error-rate counting (already out of scope in the original design).

## Decisions

### Decision 1: Single in-flight probe gate via a `probeInFlight` flag

**Decision:** Add a `probeInFlight` boolean to `CircuitBreaker`. In `execute()`, when `state === 'half-open'`: if `probeInFlight` is false, set it true and run the trial `fn`, clearing it (in `finally`) once the call resolves; if `probeInFlight` is true, fast-fail with `CircuitOpenError`. The probe's success/failure still drives the existing close/reopen logic.

**Rationale:** The breaker is in-process and single-threaded between `await` points, so a simple boolean is sufficient to admit exactly one concurrent probe. This directly realizes the design's "one probe call is allowed" statement with minimal surface area.

**Alternative considered:** A counting semaphore allowing `halfOpenProbeCount` concurrent probes. Rejected — the design specifies sequential probes, and concurrent probes reintroduce a (smaller) herd; `halfOpenProbeCount` governs how many *sequential* successes are required to close, not concurrency.

### Decision 2: Inject a logger / `onStateChange` hook rather than importing a logger

**Decision:** Add an optional logger (or an `onStateChange(key, from, to)` callback) and a breaker `key` to the constructor options. Emit `warn` on closed→open (with key + failure count) and `info` on open→half-open, half-open→closed, and half-open→open. Wire the keys (`openai_embedding`, `qdrant`) and the app logger at construction in `src/index.ts`.

**Rationale:** Constructor injection keeps `CircuitBreaker` free of module-level logger coupling, preserves testability (tests can pass a spy or no logger), and matches the existing "inject breakers as constructor parameters" decision from the original design.

**Alternative considered:** Importing the shared Pino logger directly into `circuit-breaker.ts`. Rejected — couples the pure breaker to app wiring and complicates unit tests.

### Decision 3: Wrap the Azure breaker at the `requestWithRetry` boundary

**Decision:** Move the `breaker.execute()` call from `executeSingleRequest` (per attempt) up to wrap the entire `requestWithRetry` logical operation, so the retry loop runs inside a single breaker call and contributes at most one failure. `healthCheck` continues to bypass the breaker.

**Rationale:** Aligns failure accounting with the documented "consecutive failures" semantic and makes the Azure and OpenAI providers behave identically with respect to `failure_threshold`.

**Alternative considered:** Keep per-attempt wrapping but divide `failure_threshold` by `max_attempts`. Rejected — brittle, implicit, and still double-counts when attempt counts vary.

## Risks / Trade-offs

- **[Risk] A hung probe `fn` never clears `probeInFlight`, wedging the breaker in half-open.** Mitigation: clear the flag in a `finally` so both resolution paths release it; the wrapped call sites already impose request timeouts/abort controllers, so the probe cannot hang indefinitely.
- **[Risk] Log volume on a flapping dependency.** Mitigation: logs fire only on actual transitions (not per call), so volume is bounded by transition frequency; `warn`/`info` levels let operators filter.
- **[Trade-off] Moving the Azure breaker boundary means the breaker now also guards the backoff sleeps between retries.** Accepted — this is the intended "one logical call" envelope and matches the OpenAI provider's single-call envelope.

## Migration Plan

In-process behavior change only; no config, schema, persisted state, or API surface changes. The breaker still resets on restart. No data migration. Existing tests for `add-circuit-breakers` remain valid; new tests cover the single-probe gate, transition logging, and one-failure-per-`embedBatch` accounting.

## Open Questions

- Should the logger be a full Pino instance or a narrow `onStateChange` callback that `src/index.ts` adapts to Pino? (Leaning callback for purity; either satisfies the requirement.)
- Should half-open→open log at `warn` rather than `info`, since a failed recovery probe is arguably more notable than a successful one?
