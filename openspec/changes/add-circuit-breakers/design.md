## Context

Standard circuit breaker pattern with three states:

- **Closed:** Normal operation. Failures are counted. When `failureThreshold` consecutive failures are recorded within a window, the breaker transitions to Open.
- **Open:** Fast-fail. All calls throw immediately without attempting the external service. After `openWindowMs`, transitions to Half-Open.
- **Half-Open:** One probe call is allowed. If it succeeds, transitions back to Closed and resets the failure count. If it fails, resets the Open timer and stays Open.

BHGBrain already has graceful degradation for embedding (`DegradedEmbeddingProvider`). The circuit breaker is a complementary, transient form of degradation: where `DegradedEmbeddingProvider` handles permanent credential absence, the circuit breaker handles temporary service unavailability. The distinction is important: a tripped breaker should recover automatically once the service is back; the degraded provider does not.

## Goals / Non-Goals

**Goals:**
- Protect OpenAI and Qdrant call sites from thundering-herd reconnection during outages.
- Fast-fail during Open state to return errors quickly rather than blocking on timeout.
- Auto-recover once the external service is restored (Half-Open probe).
- Expose breaker state in `/health` for monitoring visibility.
- Configurable thresholds via `resilience.circuit_breaker.*` config keys.

**Non-Goals:**
- Per-operation-type breakers (one breaker per external service is sufficient).
- Distributed breaker state across multiple BHGBrain instances (in-process only; stateless restarts reset breakers).
- Retry logic inside the circuit breaker (retries are a separate concern; use at the call site if needed).
- Changing error types thrown to callers — callers already handle `embeddingUnavailable` and `internal` errors; the breaker should throw the same error types.

## Decisions

### Decision: One breaker per external service (not per method)

**Why:** OpenAI failures typically affect all embedding operations simultaneously (rate limit, auth, network partition). Qdrant failures affect all vector operations. Per-method breakers would trip independently and create confusing partial-open states.

**Alternative considered:** Per-method breakers. Rejected — increased configuration complexity without benefit.

### Decision: Consecutive failure counting, not windowed rate

**Why:** BHGBrain's operation volume is low to moderate. A windowed error rate (e.g., 50% failure rate in 60s) requires tracking timestamps. Consecutive failure count is simpler, sufficient, and predictable.

**Alternative considered:** Windowed error rate. Deferred to a future iteration if needed.

### Decision: Inject breakers as constructor parameters, not global singletons

**Why:** Singleton breakers make testing hard (state leaks between tests). Constructor injection allows tests to provide fresh breakers and assert state transitions.

### Decision: Surface breaker state in `/health` as a named component

**Why:** An operator needs to know if `openai_embedding` or `qdrant` is circuit-open vs. genuinely unavailable. The health response already has a component map pattern (from `address-codereview-issues`); breaker state fits naturally as an additional component field.

**Health response extension:**
```json
{
  "status": "degraded",
  "components": {
    "sqlite": "healthy",
    "qdrant": "unhealthy",
    "embedding": "degraded"
  },
  "circuitBreakers": {
    "openai_embedding": "open",
    "qdrant": "closed"
  }
}
```

## Risks / Trade-offs

- **[Risk] Breaker masks real failures during Half-Open probe** → Mitigation: probe failure resets the open window; the service remains protected and will retry the probe after another `openWindowMs`.
- **[Risk] Too-tight threshold trips on transient single errors** → Mitigation: default `failureThreshold: 5` prevents single-error trips; configurable for environments with stricter SLOs.
- **[Risk] Breaker state is lost on process restart** → Accepted. BHGBrain is a single-process server; in-process state is appropriate. Persisting breaker state would add complexity without proportional benefit.
