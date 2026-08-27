## 1. Gate Half-Open to a single in-flight probe

- [x] 1.1 Add a `probeInFlight` flag to `CircuitBreaker` (`src/resilience/circuit-breaker.ts`).
- [x] 1.2 In `execute<T>()`, after the Open fast-fail check, when `state === 'half-open'`: if no probe is in flight, claim it (`probeInFlight = true`) and run `fn`; otherwise fast-fail with `CircuitOpenError`.
- [x] 1.3 Clear `probeInFlight` in a `finally`/on resolution of the probe (both success and failure paths), and reset it in `open()`/`close()` so a reopen cycle starts clean.
- [x] 1.4 Confirm a probe that succeeds still closes the breaker per `halfOpenProbeCount` and a probe that fails still reopens it.

## 2. Log breaker state transitions

- [x] 2.1 Add an optional logger (or `onStateChange(key, from, to)` callback) plus a breaker `key` to `CircuitBreakerOptions`/constructor.
- [x] 2.2 Emit a Pino `warn` on closed→open (including breaker key and failure count) and `info` on open→half-open, half-open→closed, and half-open→open transitions, each carrying the breaker key and from/to state.
- [x] 2.3 Wire the breaker keys (`openai_embedding`, `qdrant`) and the logger at construction in `src/index.ts`.

## 3. Fix Azure per-retry breaker wrapping

- [x] 3.1 Move the breaker `execute()` boundary in `src/embedding/azure-foundry.ts` from `executeSingleRequest` (per attempt) to wrap the whole `requestWithRetry` logical call.
- [x] 3.2 Ensure `healthCheck` still bypasses the breaker (no breaker accounting for health probes).
- [x] 3.3 Confirm one `embedBatch` records at most one breaker failure even when it exhausts `retry.max_attempts`.

## 4. Documentation fix

- [x] 4.1 Update `openspec/changes/add-circuit-breakers/proposal.md` and `tasks.md` references from `QdrantStorage` to `QdrantStore`.

## 5. Validation

- [x] 5.1 Run `npm run lint`, `npm test`, and `npm run build`.
