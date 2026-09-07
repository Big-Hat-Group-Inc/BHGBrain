## Why

Qdrant calls, collection fan-out, health probes, MCP sessions, and rate-limit state can consume unbounded time or memory. During dependency failure, the current health route can amplify the outage while still returning a successful readiness status.

## What Changes

- Add a configurable Qdrant request timeout and route operational calls through the circuit breaker, while keeping a deliberate bounded health probe.
- Cache and rate-limit health probes, separate liveness from authenticated diagnostics, and return readiness failure when required dependencies are degraded.
- Bound collectionless query fan-out and expose its width and failure state.
- Add MCP session idle expiry, a maximum session count, periodic cleanup, and a session-count metric.
- Bound rate-limit buckets and replace all-proxy trust with explicit hop/subnet trust configuration.
- Narrow Qdrant not-found handling so routing, authorization, and service errors cannot appear healthy.

## Capabilities

### New Capabilities
- `bounded-service-runtime`: Defines dependency deadlines, breaker coverage, health/readiness behavior, bounded request fan-out, session lifecycle, and proxy-safe rate limiting.

### Modified Capabilities

## Impact

- Affected code: `src/storage/qdrant.ts`, `src/search/index.ts`, `src/transport/http.ts`, `src/transport/mcp-http.ts`, `src/transport/middleware.ts`, `src/health/index.ts`, configuration, Docker health checks, and transport tests.
- Audit coverage: F13, F14, F18, F27, F52, and F63.
- Configuration: adds bounded Qdrant timeout, MCP session lifetime/capacity, fan-out, and proxy-trust settings.
