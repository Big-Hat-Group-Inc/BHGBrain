# Code Audit — OpenSpec proposal `add-circuit-breakers`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `add-circuit-breakers`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 11 key files — `src/resilience/circuit-breaker.ts`, `src/resilience/index.ts`, `src/resilience/circuit-breaker.test.ts`, `src/embedding/index.ts`, `src/embedding/azure-foundry.ts`, `src/storage/qdrant.ts`, `src/health/index.ts`, `src/config/index.ts`, `src/index.ts`, plus embedding/health test files; proposal/tasks/design docs.

## Executive summary

The proposal is implemented end-to-end and well-tested: the `CircuitBreaker` class, config schema, embedding/Qdrant wrapping, startup wiring, and `/health` visibility are all present, and the implementation correctly exceeds the proposal by also covering the Azure-Foundry provider (provider-aware breaker keys). No Critical or High findings. The main gaps are observability (zero log events on state transitions — the breaker is only visible via `/health` polling), one genuine **design drift** (half-open allows unbounded concurrent probes where the design specifies a single probe), and a subtle failure-count inflation in the Azure provider where the breaker wraps each retry attempt. Headline counts: 0 Critical, 0 High, 3 Medium, 6 Low.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| 1.1 `resilience.circuit_breaker` Zod block (threshold/window/probe) with stated defaults | Done | `src/config/index.ts:121-127` |
| 1.2 Export `ResilienceConfig` type | Done | `src/config/index.ts:160` |
| 1.3 `resilience` on `BrainConfig`, parsing tests pass | Done | inferred from `ConfigSchema` `src/config/index.ts:157,159`; `.default({})` keeps existing configs valid |
| 2.1 Create `circuit-breaker.ts` | Done | `src/resilience/circuit-breaker.ts:1` |
| 2.2 Three states as union | Done | `src/resilience/circuit-breaker.ts:1` (`CircuitBreakerState`) |
| 2.3 `execute<T>` throws `CircuitOpenError` when open | Done | `src/resilience/circuit-breaker.ts:27-42,30-32` |
| 2.4 State transition logic (all four transitions) | Done (with drift) | `src/resilience/circuit-breaker.ts:56-96`; half-open concurrency drift — see F2 |
| 2.5 `getState()` + `getStats()` | Done | `src/resilience/circuit-breaker.ts:44-54`; `getStats().failures` semantics imprecise while open — see F5 |
| 2.6 `index.ts` re-export of `CircuitBreaker` + `CircuitOpenError` | Done | `src/resilience/index.ts:1` |
| 3.1 `breaker?` param on `OpenAIEmbeddingProvider` ctor | Done | `src/embedding/index.ts:25-29` |
| 3.2 Wrap embed fetch with `breaker?.execute() ?? fetch()` | Done | `src/embedding/index.ts:66-84` (`requestEmbeddings(useBreaker)`) |
| 3.3 `healthCheck` bypasses breaker | Done | `src/embedding/index.ts:56-64` calls `requestEmbeddings(..., false)`; test `src/embedding/index.test.ts:146-158` |
| 4.1 `breaker?` param on Qdrant storage ctor | Done | `src/storage/qdrant.ts:13-16` (class is `QdrantStore`, not `QdrantStorage` — naming drift F6) |
| 4.2 Wrap `search`, `upsert`, `delete` | Done | `src/storage/qdrant.ts:83,98,158` via `executeWithBreaker` — but other outbound calls remain unwrapped, F8 |
| 4.3 Tripped breaker throws `internal` BrainError, not raw `CircuitOpenError` | Done | `src/storage/qdrant.ts:281-294` |
| 5.1 Instantiate breakers from config | Done | `src/index.ts:50-56` |
| 5.2 Pass embedding breaker | Done | `src/index.ts:59` |
| 5.3 Pass Qdrant breaker | Done | `src/index.ts:58` |
| 5.4 Pass breakers to HealthService | Done | `src/index.ts:80-83` |
| 6.1 HealthService accepts `breakers` map | Done | `src/health/index.ts:19` |
| 6.2 `circuitBreakers` field in health response | Done | `src/health/index.ts:48,184-188` |
| 6.3 Any open breaker → `degraded` | Done | `src/health/index.ts:160` |
| 7.1 CircuitBreaker unit tests (all transitions) | Done | `src/resilience/circuit-breaker.test.ts:5-64` |
| 7.2 Embedding-provider breaker tests (invoked + healthCheck bypass) | Done | `src/embedding/index.test.ts:100-112,146-158`; also `azure-foundry.test.ts:264-291` |
| 7.3 HealthService tripped-breaker test (open + degraded) | Done | `src/health/index.test.ts:131-171` |
| 8.x Build/test/commit/push | Done | committed `a78caf1`; resilience files tracked in git |
| Proposal: "automatic recovery probing" / fast-fail | Done | half-open transition `src/resilience/circuit-breaker.ts:80-89`; fast-fail `:30-32` |
| Proposal/design: surface state per service in `/health` | Done | `src/health/index.ts:184-188`, design JSON shape matches |
| Modified capability: embedding degradation includes transient circuit-open | Done | `CircuitOpenError` from open breaker is caught and rethrown as `embeddingUnavailable` `src/embedding/index.ts:49-50` |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| F1 | Medium | High | S | Logging & observability | `src/resilience/circuit-breaker.ts:91-102` | No log events on open/half-open/close transitions; breaker only observable via `/health` polling |
| F2 | Medium | High | S | Stability / Maintainability (drift) | `src/resilience/circuit-breaker.ts:27-42` | Half-open allows unbounded concurrent probes; design specifies a single probe call |
| F3 | Medium | Medium | M | Stability & reliability | `src/embedding/azure-foundry.ts:110-185` | Breaker wraps each retry attempt, so one `embedBatch` can record multiple failures, tripping the breaker faster than `failure_threshold` logical calls |
| F4 | Low | High | S | Maintainability | `src/resilience/circuit-breaker.ts:44-47,80-89` | `getState()` mutates state (side-effecting getter); health polling drives the half-open transition |
| F5 | Low | Medium | S | Logging & observability | `src/resilience/circuit-breaker.ts:91-93` | `open()` sets `failures = failureThreshold`, so `getStats().failures` no longer reflects the real running count |
| F6 | Low | High | S | Maintainability (drift) | `src/storage/qdrant.ts:9` | Class is `QdrantStore`; proposal/tasks reference `QdrantStorage` — docs/spec naming drift |
| F7 | Low | High | S | Stability & reliability | `src/storage/qdrant.ts:114-128,173-193,243-270` | Several outbound Qdrant calls (`deleteMany`, `searchSimilar`, `scrollAll`) bypass the breaker, weakening fast-fail coverage |
| F8 | Low | Medium | S | Stability & reliability | `src/storage/qdrant.ts:83-95` | `upsert` runs `ensureCollection` (multiple outbound calls) inside one breaker `execute`; a slow collection-create blocks the breaker call without per-call accounting |
| F9 | Low | Low | S | Testing & coverage | `src/resilience/circuit-breaker.test.ts` | No test asserts the half-open success counter reset between reopen cycles or `halfOpenProbeCount > 1` with an interleaved failure |

## Quick wins

- F1: add Pino log lines (warn on open, info on half-open/close) inside `open()`/`close()`/`transitionToHalfOpenIfReady()` or via an injected callback. Highest observability ROI for effort S.
- F6: rename references in `proposal.md`/`tasks.md` (or add a note) from `QdrantStorage` to `QdrantStore` so the spec matches the code.
- F4/F5: small clarity fixes (see below).

## Performance

### [Low · Medium · S] `upsert` couples collection-creation latency into a single breaker call — `src/storage/qdrant.ts:83-95`
**Issue:** `upsert` wraps `ensureCollection` (which issues `getCollection`, `createCollection`, and six `createPayloadIndex` calls) plus the `upsert` itself inside one `executeWithBreaker`. On a cold collection that is several sequential round-trips counted as one breaker operation.
**Why it matters:** A slow/partial Qdrant during collection bootstrap can hold a breaker `execute` open for the full multi-call duration, and a failure at any step counts as a single failure regardless of which call failed — making failure accounting coarse on the write hot path.
**Recommendation:** Acceptable for now (the proposal scoped breaker to `upsert`), but consider moving `ensureCollection` outside the breaker or giving it its own lightweight guard so vector writes and schema bootstrap are accounted separately.

## Logging & observability

### [Medium · High · S] No log events on circuit-breaker state transitions — `src/resilience/circuit-breaker.ts:91-102`
**Issue:** `open()`, `close()`, and `transitionToHalfOpenIfReady()` mutate state silently. There is no Pino logging anywhere in `src/resilience/` (`grep` for `logger.` returns nothing), and neither the embedding nor Qdrant wrappers log when a breaker trips.
**Why it matters:** The proposal's stated goal is operator visibility into degradation. As built, a tripped breaker is only discoverable by actively polling `/health`; there is no event in the log stream marking when OpenAI/Qdrant degradation began or recovered, which is exactly the signal an on-call operator greps for during an incident.
**Recommendation:** Inject an optional logger or `onStateChange(name, from, to)` callback into `CircuitBreaker`, and emit `warn` on Closed→Open (with service name and failure count) and `info` on transitions back to Half-Open/Closed. Wire the service name (`openai_embedding`/`qdrant`) at construction in `src/index.ts:55-56`.

### [Low · Medium · S] `getStats().failures` is overwritten on open — `src/resilience/circuit-breaker.ts:91-93`
**Issue:** `open()` sets `this.failures = this.options.failureThreshold`. Once open, `getStats().failures` always returns the threshold, not the real consecutive-failure tally that occurred.
**Why it matters:** `getStats` exists specifically for health/diagnostic reporting (task 2.5). Reporting a constant equal to the threshold removes the diagnostic value (e.g. "how many failures since open" / how deep the outage is).
**Recommendation:** Don't reassign `failures` in `open()`; leave the running count intact, or add a separate `openedWithFailures` field if the reset is intentional for re-trip math.

## Stability & reliability

### [Medium · High · S] Half-open admits unbounded concurrent probes (design drift) — `src/resilience/circuit-breaker.ts:27-42`
**Issue:** `execute()` only fast-fails when `state === 'open'`. In `half-open`, every concurrent caller proceeds to run `fn()`. `design.md:6-7` states: "One probe call is allowed. If it succeeds, transitions back to Closed." Under concurrent load the breaker fires N simultaneous probes at the still-recovering service.
**Why it matters:** The whole point of the half-open state is to send a *single* canary against a recovering dependency to avoid a thundering herd — the proposal's primary motivation. With no in-flight probe gate, the moment the open window elapses a burst of queued requests all hit OpenAI/Qdrant at once, defeating the protection during the most fragile recovery moment.
**Recommendation:** Gate half-open to a single in-flight probe: when transitioning to half-open, allow one `execute` through and mark a `probeInFlight` flag; additional concurrent calls fast-fail with `CircuitOpenError` until the probe resolves. Update the design doc or the implementation so they agree.

### [Medium · Medium · M] Azure provider trips breaker faster than `failure_threshold` due to per-attempt wrapping — `src/embedding/azure-foundry.ts:110-185`
**Issue:** The breaker wraps `executeSingleRequest` (line 180-182), which is invoked once per retry attempt inside `requestWithRetry`. A single `embedBatch` call that retries up to `retry.max_attempts` times therefore records up to that many breaker failures for one logical operation. (The OpenAI provider has no retry loop, so it is one-failure-per-call and unaffected.)
**Why it matters:** With `failure_threshold: 5` and, say, 3 retry attempts, two failing batches can already trip the breaker even though only two logical operations failed — making the breaker far more sensitive than the configured threshold implies and inconsistent between the two providers. `CircuitOpenError` is correctly non-retryable (`isRetryableError` at `:202-210` returns false for it), so there is no retry storm, but the count inflation is real.
**Recommendation:** Wrap at the `requestWithRetry` boundary (one breaker `execute` per logical embed request) rather than per attempt, so failure accounting matches the documented "consecutive failures" semantic and is consistent with the OpenAI provider.

### [Low · High · S] Multiple outbound Qdrant calls bypass the breaker — `src/storage/qdrant.ts:114-128,173-193,243-270`
**Issue:** `deleteMany`, `searchSimilar`, and `scrollAll` issue `client.delete`/`client.search`/`client.scroll` directly with no `executeWithBreaker`. (`ensureCollection`, `getCollectionInfo`, `createSnapshot`, `deleteCollection`, `listAllCollections` are also unwrapped, though `clearManagedCollections` and `ensureCollection`-via-`upsert` are partially covered.)
**Why it matters:** The proposal scoped the breaker to `search`/`upsert`/`delete`, so this is in-spec, but operationally these unwrapped paths (notably `scrollAll`, used in bootstrap/retention sweeps, and `searchSimilar`, used in dedup) will still blast a downed Qdrant during an outage, partially undermining the "no thundering herd" goal.
**Recommendation:** Note explicitly in the design that these paths are intentionally unprotected, or extend `executeWithBreaker` to `searchSimilar`/`scrollAll`/`deleteMany` (they already share the same `client` and the same outage mode).

## Security

No issues found. The breaker introduces no new input surface, holds no secrets, and `CircuitOpenError`/`internal()` messages are static ("Circuit breaker is open" / "Qdrant circuit breaker is open") with no leakage of credentials or upstream payloads.

## Maintainability & code quality

### [Low · High · S] `getState()` mutates breaker state (side-effecting getter) — `src/resilience/circuit-breaker.ts:44-47`
**Issue:** `getState()` calls `transitionToHalfOpenIfReady()`, so reading the state can flip Open→Half-Open. The health service calls `getState()` on every `/health` check (`src/health/index.ts:160,186`), meaning health polling — not request traffic — is what drives the recovery transition.
**Why it matters:** A getter with side effects is surprising and couples recovery timing to monitoring cadence. If `/health` is polled rarely, recovery is delayed; in tests, asserting state via `getState()` (as `circuit-breaker.test.ts:24` does) is what advances the breaker, which can mask whether `execute()` alone would transition.
**Recommendation:** Keep the lazy time-based transition but document it clearly, or move the half-open evaluation strictly into `execute()` and make `getState()` a pure read used only for reporting. Current behavior is functional; this is a clarity/robustness note.

### [Low · High · S] Proposal/tasks reference `QdrantStorage`; code is `QdrantStore` — `src/storage/qdrant.ts:9`
**Issue:** `proposal.md:11,30` and `tasks.md` (section 4) name the class `QdrantStorage`. The actual class is `QdrantStore`.
**Why it matters:** Minor spec/code drift; harmless at runtime but makes the proposal slightly misleading for future readers and breaks naive grep-by-spec.
**Recommendation:** Update the proposal/tasks wording (or add a note) to `QdrantStore`.

## Testing & coverage

### [Low · Low · S] Missing edge-case tests for half-open probe counting — `src/resilience/circuit-breaker.test.ts`
**Issue:** Tests cover Closed→Open, fast-fail, Open→Half-Open, Half-Open→Closed (single and `halfOpenProbeCount: 2`), and Half-Open→Open on probe failure. Not covered: a partial half-open sequence (success then failure before reaching `halfOpenProbeCount > 1`) to confirm `halfOpenSuccesses` resets correctly on reopen, and assertion that `failures` is fully reset to 0 after a successful close cycle (only checked once at `:44`).
**Why it matters:** The half-open success counter (`halfOpenSuccesses`) is reset in three places (`open`, `close`, `transitionToHalfOpenIfReady`); an interleaved-probe test would guard against regressions in that reset logic, which is the subtlest part of the state machine.
**Recommendation:** Add a test with `halfOpenProbeCount: 2` where probe-1 succeeds and probe-2 fails, asserting the breaker reopens and a later clean two-probe sequence still closes it.

Overall the test suite is solid and directly targets the proposal's required scenarios (7.1–7.3 all present and meaningful, including provider-aware breaker keys).

## Dependencies & supply chain

No issues found. The feature adds no new dependencies — `CircuitBreaker` is pure first-party TypeScript with an injectable `now()` clock. Existing deps (`@qdrant/js-client-rest ^1.13.0`, `zod ^3.24.2`, `vitest ^3.0.8`) are unchanged and reasonably pinned with caret ranges consistent with the rest of the project.

## Recommendations (prioritized)

1. **F1 — Add transition logging** (Medium, S): emit Pino warn/info on open/half-open/close with the service name; this is the single biggest gap versus the proposal's observability goal.
2. **F2 — Gate half-open to one in-flight probe** (Medium, S): align the implementation with `design.md`'s single-probe semantic to actually prevent the recovery thundering herd.
3. **F3 — Wrap the Azure breaker at the per-request (not per-retry) boundary** (Medium, M): make failure counting consistent with the documented consecutive-failure semantic and with the OpenAI provider.
4. **F7 — Decide and document breaker coverage for `searchSimilar`/`scrollAll`/`deleteMany`** (Low, S): either protect them or record that they are intentionally out of scope.
5. **F5/F4 — Clarify `getStats().failures` semantics and the side-effecting `getState()`** (Low, S): preserve real failure counts for diagnostics and document the polling-driven transition.
6. **F6 — Fix `QdrantStorage` → `QdrantStore` naming in the proposal/tasks** (Low, S).
7. **F9 — Add the interleaved half-open probe test** (Low, S).
