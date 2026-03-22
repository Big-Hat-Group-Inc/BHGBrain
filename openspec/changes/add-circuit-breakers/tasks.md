## 1. Config Schema

- [x] 1.1 Add `resilience` block to `src/config/index.ts` Zod schema with `circuit_breaker` sub-object:
  - `failure_threshold: z.number().int().min(1).default(5)` — consecutive failures before Open
  - `open_window_ms: z.number().int().min(1000).default(30000)` — time in Open state before Half-Open probe
  - `half_open_probe_count: z.number().int().min(1).default(1)` — successful probes required to close
- [x] 1.2 Export `ResilienceConfig` type from config module
- [x] 1.3 Add `resilience` to `BrainConfig` and confirm existing config parsing tests still pass

## 2. Implement `CircuitBreaker`

- [x] 2.1 Create `src/resilience/circuit-breaker.ts`
- [x] 2.2 Implement three states as a discriminated union or enum: `closed | open | half-open`
- [x] 2.3 Implement `execute<T>(fn: () => Promise<T>): Promise<T>` — throws `CircuitOpenError` immediately when Open; runs `fn`, tracks success/failure for state transitions
- [x] 2.4 Implement state transition logic:
  - Closed → Open: on `failureThreshold` consecutive failures
  - Open → Half-Open: after `openWindowMs` elapsed since last Open transition
  - Half-Open → Closed: on `halfOpenProbeCount` successful executions; reset failure counter
  - Half-Open → Open: on any failure during probe; reset Open timer
- [x] 2.5 Expose `getState(): 'closed' | 'open' | 'half-open'` and `getStats(): { failures: number; lastOpenedAt: Date | null }` for health reporting
- [x] 2.6 Create `src/resilience/index.ts` re-exporting `CircuitBreaker` and `CircuitOpenError`

## 3. Wrap OpenAI Embedding Provider

- [x] 3.1 Add `breaker?: CircuitBreaker` parameter to `OpenAIEmbeddingProvider` constructor
- [x] 3.2 In `embedBatch`, wrap the `fetch` call with `this.breaker?.execute(() => fetch(...)) ?? fetch(...)` — falls back to direct call when no breaker is injected (backward compatibility, and for tests that don't need a breaker)
- [x] 3.3 Confirm `healthCheck` does NOT go through the circuit breaker (health checks are intentional probes and should bypass fast-fail)

## 4. Wrap Qdrant Storage

- [x] 4.1 Add `breaker?: CircuitBreaker` parameter to `QdrantStorage` constructor
- [x] 4.2 Wrap `search`, `upsert`, and `delete` method bodies with `this.breaker?.execute(...)` 
- [x] 4.3 Confirm that a tripped breaker throws an `internal` BrainError (not a raw `CircuitOpenError`) so callers receive a consistent error type

## 5. Wire at Startup

- [x] 5.1 In `src/index.ts`, instantiate `CircuitBreaker` instances for `openai_embedding` and `qdrant` using config from `config.resilience.circuit_breaker`
- [x] 5.2 Pass the embedding breaker to `OpenAIEmbeddingProvider` constructor
- [x] 5.3 Pass the Qdrant breaker to `QdrantStorage` constructor
- [x] 5.4 Pass both breaker instances to `HealthService` for state reporting

## 6. Health Visibility

- [x] 6.1 Update `HealthService` to accept a `breakers: Record<string, CircuitBreaker>` map
- [x] 6.2 Add `circuitBreakers` field to the health check response: `{ [name]: 'closed' | 'open' | 'half-open' }`
- [x] 6.3 If any breaker is `open`, health status should be `degraded` (not `healthy`) even if the component itself would otherwise report healthy

## 7. Tests

- [x] 7.1 Unit test `CircuitBreaker`: assert Closed → Open transition at `failureThreshold`, fast-fail when Open, Open → Half-Open after `openWindowMs`, Half-Open → Closed on success, Half-Open → Open on failure
- [x] 7.2 Unit test `OpenAIEmbeddingProvider` with a breaker stub: assert breaker is invoked on embed calls; assert `healthCheck` bypasses the breaker
- [x] 7.3 Unit test `HealthService` with a tripped breaker: assert `circuitBreakers.openai_embedding` is `'open'` and overall status is `'degraded'`

## 8. Commit

- [x] 8.1 Run `npm test` — confirm all tests pass
- [x] 8.2 Run `tsc --noEmit` — confirm zero type errors
- [x] 8.3 Commit with message: `feat: add circuit breakers for OpenAI and Qdrant with health visibility (codereview2)`
- [x] 8.4 Push to active branch
