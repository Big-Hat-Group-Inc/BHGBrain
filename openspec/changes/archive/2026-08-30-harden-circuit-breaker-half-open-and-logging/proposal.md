## Why

The completed `add-circuit-breakers` change ships a working breaker, but a code audit (`codeaudit/add-circuit-breakers-2026-06-05-02-19.md`) found three behavioral gaps that undercut the breaker's stated goals: the Half-Open state admits unbounded concurrent probes (thundering herd against a recovering dependency — the exact failure the breaker exists to prevent), state transitions emit no log events (degradation is only observable by polling `/health`), and the Azure provider wraps the breaker per retry attempt so one logical embed can trip the breaker faster than `failure_threshold` implies. This change hardens those three behaviors.

## What Changes

- Gate Half-Open to exactly one in-flight trial request: the first caller after the open window elapses runs the probe; all other concurrent callers fast-fail with `CircuitOpenError` until that probe resolves.
- Emit structured (Pino) log events on every breaker state transition (closed→open, open→half-open, half-open→closed, half-open→open) including the breaker key and the from/to states.
- Wrap the Azure-Foundry embedding breaker at the `requestWithRetry` (one-per-logical-`embedBatch`) boundary instead of per-attempt, so a single `embedBatch` records at most one breaker failure regardless of internal retries.
- Fix the `QdrantStorage` → `QdrantStore` naming drift in the `add-circuit-breakers` proposal/tasks docs.

## Capabilities

### New Capabilities
- `circuit-breaker-half-open-control`: Half-Open state admits a single trial request while short-circuiting concurrent callers, and every breaker state transition is logged with breaker key and from/to state.

### Modified Capabilities

_None._

## Impact

- Affected code:
  - `src/resilience/circuit-breaker.ts` — single-probe gating in `execute()`; transition logging hook (injected logger or `onStateChange` callback) emitted from `open()`/`close()`/`transitionToHalfOpenIfReady()`.
  - `src/embedding/azure-foundry.ts` — move breaker wrapping from `executeSingleRequest` (per attempt) to the `requestWithRetry` boundary (per logical request).
  - `src/index.ts` — wire breaker keys (`openai_embedding`, `qdrant`) and the logger into breaker construction.
  - `openspec/changes/add-circuit-breakers/proposal.md`, `openspec/changes/add-circuit-breakers/tasks.md` — `QdrantStorage` → `QdrantStore` doc fix.
- Reliability notes:
  - Restores the design's single-canary Half-Open semantic, preventing a burst of queued requests from hitting a fragile recovering dependency.
  - Operators gain log-stream visibility of when each dependency began and ended degradation, instead of relying on `/health` polling cadence.
  - Breaker failure accounting becomes consistent between the OpenAI and Azure providers (one logical call = at most one failure), so a configured `failure_threshold` means the same thing for both.
  - No new dependencies; no public error-type or config-schema changes; in-process behavior only.
