## Context

The Qdrant client inherits a 300-second default timeout, several methods bypass the breaker, the detailed health route is public, and HTTP-owned registries/fan-out grow with clients or collections. See `proposal.md` and `specs/bounded-service-runtime/spec.md`.

## Goals / Non-Goals

**Goals:**
- Bound dependency time, per-request concurrency, and resident registries.
- Make public liveness cheap and readiness truthful.
- Preserve safe operation behind trusted reverse proxies.

**Non-Goals:**
- Replacing Express, the MCP SDK, or the Qdrant client.
- Guaranteeing availability when Qdrant is unavailable.

## Decisions

1. Configure Qdrant's client timeout below the HTTP operation deadline.
- All operational methods use one breaker wrapper; health deliberately bypasses it with a shorter independent timeout and short cache.
- Per-call ad hoc races were rejected because they would not cancel underlying client work consistently.

2. Split `/health/live`, `/health/ready`, and authenticated diagnostics.
- Liveness checks process responsiveness only; readiness checks cached required dependencies and returns 503 on degradation; the full snapshot remains behind auth and rate limits.
- Returning 200 for degraded readiness was rejected because orchestrators cannot act on it.

3. Store MCP sessions with `lastSeenAt` in a capacity-bounded registry.
- Request handling refreshes activity. An unref'd periodic sweep closes idle sessions, and insertion at capacity evicts the oldest idle entry or returns 503 if none is safely evictable.
- Relying on clients to send DELETE was rejected because normal client abandonment is common.

4. Use a shared concurrency limiter for collection fan-out.
- Configuration caps target collections, in-flight queries, per-target results, and payload vectors; response metadata reports applied truncation.
- One unrestricted `Promise.all` was rejected due to cascading breaker failures.

5. Model proxy trust as Express-compatible hop count or subnet lists.
- Existing `false` remains the secure default. The legacy boolean `true` will fail validation with migration guidance.
- Trusting every hop was rejected because caller-supplied left-most XFF becomes authoritative.

6. Bound rate-limit buckets with a timer and fail-closed capacity policy.
- Expired buckets are swept independently; at hard capacity, a final sweep occurs and new keys are rejected rather than stored.
- Evicting arbitrary active buckets was rejected because it allows rate-limit resets.

## Risks / Trade-offs

- [Shorter dependency timeout rejects slow healthy clusters] -> Make it configurable and document its relation to HTTP deadlines.
- [Session eviction interrupts dormant clients] -> Use an explicit idle interval, log eviction, and return a clear unknown-session response on reuse.
- [Readiness 503 changes deployment behavior] -> Update Docker/README probes and separate liveness for restart decisions.

## Migration Plan

1. Add validated timeout, session, fan-out, bucket, and proxy configuration with conservative defaults.
2. Wrap Qdrant operations and narrow not-found classification.
3. Split health endpoints and update container probes.
4. Add registry sweeps/metrics and bounded fan-out.
5. Document migration from `trust_proxy: true` to hop/subnet configuration.
