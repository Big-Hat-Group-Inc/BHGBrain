## Why

BHGBrain makes synchronous outbound calls to two external services: OpenAI (embedding) and Qdrant (vector search and storage). Neither has a circuit breaker. Under sustained failure — OpenAI rate limit event, Qdrant network partition, or a credential rotation — every incoming request that touches these services will fail immediately after its timeout, with no fast-fail or recovery window. This burns request budget, creates thundering-herd reconnection pressure, and prevents the system from recovering gracefully once the external service is restored.

codereview2.md calls this out explicitly under Operational Readiness: "Implement circuit breakers for external service calls (OpenAI, Qdrant) with configurable thresholds."

## What Changes

- Introduce a `CircuitBreaker` class in `src/resilience/circuit-breaker.ts` with standard three-state semantics: **Closed** (normal), **Open** (fast-fail), **Half-Open** (probe).
- Wrap `OpenAIEmbeddingProvider.embedBatch` with a circuit breaker instance.
- Wrap `QdrantStorage.search`, `QdrantStorage.upsert`, and `QdrantStorage.delete` with a circuit breaker instance.
- Expose circuit breaker state in the health check response (`/health`) so degradation from a tripped breaker is externally observable.
- Add configuration keys under `resilience.circuit_breaker.*` to control failure threshold, open window duration, and half-open probe count.

## Capabilities

### New Capabilities
- `circuit-breaker-resilience`: External service calls (OpenAI, Qdrant) are protected by configurable circuit breakers with Closed/Open/Half-Open state, fast-fail on open, and automatic recovery probing.
- `circuit-breaker-health-visibility`: Circuit breaker state is included in the `/health` response, making tripped breakers observable to monitoring systems and operators.

### Modified Capabilities
- `degraded-embedding-and-health-semantics`: Embedding degradation now includes transient circuit-open state in addition to permanent missing-credentials degradation.

## Impact

- New file: `src/resilience/circuit-breaker.ts`
- New file: `src/resilience/index.ts` (re-export)
- `src/embedding/index.ts` — `OpenAIEmbeddingProvider` wraps `embedBatch` with breaker
- `src/storage/qdrant.ts` — `QdrantStorage` wraps outbound methods with breaker
- `src/health/index.ts` — Health check includes breaker state per service
- `src/config/index.ts` — Add `resilience.circuit_breaker` config block with Zod schema
- `src/index.ts` — Instantiate and inject circuit breakers at startup
- Configuration: 3 new keys with sensible defaults (failure threshold: 5, open window: 30s, half-open probes: 1)
