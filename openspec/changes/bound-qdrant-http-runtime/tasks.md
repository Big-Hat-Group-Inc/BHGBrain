## 1. Dependency and Query Bounds

- [x] 1.1 Add validated Qdrant operational and health timeout settings and pass them to every client construction; verify a stalled test endpoint aborts within each configured deadline.
- [x] 1.2 Route cleanup, list, scroll, batch delete, collection info/delete, and snapshot operations through the shared breaker while keeping the health probe deliberately independent; verify repeated 5xx opens the operational breaker.
- [x] 1.3 Narrow not-found classification by operation and verify a route-wide 404 reports unhealthy while a confirmed missing collection remains idempotent.
- [x] 1.4 Add a configurable collection fan-out cap, concurrency limiter, per-target result budget, and width metric; verify a many-collection query never exceeds the in-flight limit.

## 2. Health and HTTP State Bounds

- [x] 2.1 Split cheap liveness, cached readiness, and authenticated diagnostic health responses and verify Qdrant degradation yields liveness success plus readiness 503.
- [x] 2.2 Register rate limiting before public readiness probes and verify repeated unauthenticated probes cannot start unbounded dependency requests.
- [x] 2.3 Replace boolean proxy trust with validated false, hop-count, or subnet configuration and verify spoofed left-most XFF cannot choose client identity behind a one-hop proxy.
- [x] 2.4 Bound rate-limit buckets with an independent unref'd sweep and fail-closed capacity behavior; verify rotating client keys cannot exceed the configured map size.

## 3. MCP Session Lifecycle

- [x] 3.1 Store per-session activity timestamps and refresh them on supported MCP methods; verify activity postpones idle expiry.
- [x] 3.2 Add maximum session capacity plus safe oldest-idle eviction or 503 behavior and verify ordinary abandoned sessions cannot grow memory without bound.
- [x] 3.3 Add an unref'd idle sweep, session gauges/counters, and shutdown cleanup and verify all timers and transports close through `closeAll`.
- [x] 3.4 Update Docker readiness/liveness probes and HTTP configuration docs, then run transport/Qdrant/health tests plus `npm run lint`, `npm test`, and `npm run build`.
