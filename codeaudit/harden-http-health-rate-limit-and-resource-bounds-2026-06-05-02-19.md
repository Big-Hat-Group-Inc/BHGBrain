# Code Audit — OpenSpec proposal `harden-http-health-rate-limit-and-resource-bounds`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `harden-http-health-rate-limit-and-resource-bounds`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Express, Zod config, Pino, Vitest
- **Files reviewed:** 14 (proposal.md, tasks.md, design.md, 3 spec deltas, `src/transport/middleware.ts` + test, `src/transport/http.ts` + test, `src/resources/index.ts` + test, `src/config/index.ts`, `README.md`, `.env.example`)

## Executive summary

The proposal is substantially implemented and all four task groups are coded with co-located tests; documentation (`README.md`) is well-synced with the new health/auth, rate-limit, and pagination-bounds behavior. Spec compliance is strong: every requirement scenario maps to working code. The remaining risks are concentrated in the rate limiter and auth middleware: the rate-limit identity (`req.ip`) is taken without Express `trust proxy` being configured, which is *safe by default* but undermines the design's "respecting proxy config" intent and silently collapses all clients behind a reverse proxy into one bucket; the global mutable bucket `Map` is module-level shared mutable state; and the bearer-token comparison is a non-constant-time `!==`. No Critical issues were found. Headline counts: 0 Critical, 0 High, 4 Medium, 4 Low.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| Req: Health endpoint has explicit unauthenticated access policy | Done | `src/transport/middleware.ts:14-17` (auth bypass for `/health`); route registered before auth at `src/transport/http.ts:29-36` |
| Scenario: Token configured, `/health` without Authorization → no `AUTH_REQUIRED` | Done | Test `src/transport/middleware.test.ts:23-40`; integration `src/transport/http.test.ts:131-147` |
| Req: Health remains loopback-scoped; startup fails before serving on non-loopback | Done | `validateLoopbackBinding` `src/transport/middleware.ts:128-137`, called first in `createHttpServer` `src/transport/http.ts:21` before any route/listen |
| Scenario: Non-loopback + enforcement → startup fails before any route | Partial | Logic correct (`middleware.ts:132-136`); no test exercises `validateLoopbackBinding` throwing (only `validateExternalAuthBinding` is tested) |
| Req: Rate limiting uses trusted client identity (not caller headers) | Done | `src/transport/middleware.ts:77,80` key on `req.ip`; `x-client-id` is metadata only (`:78,:94`) |
| Scenario: Rotating `x-client-id` from same source cannot bypass | Done | Test `src/transport/middleware.test.ts:42-58` |
| Req: Rate limiter storage is bounded over time (evict expired buckets) | Done | Sweep loop `src/transport/middleware.ts:68-75` + per-key reset `:81-84` |
| Scenario: High-cardinality clients, expired buckets removed | Done | Test `src/transport/middleware.test.ts:60-82` |
| Req: Resource list `limit` validated & bounded (integer, range) | Done | `parseListLimit` `src/resources/index.ts:94-118` (min 1, max 100) |
| Scenario: `limit=abc` → `INVALID_INPUT` | Done | `src/resources/index.ts:96-104`; test `src/resources/index.test.ts:61-65` |
| Scenario: `limit` out of bounds → `INVALID_INPUT` | Done | `src/resources/index.ts:107-115`; test `src/resources/index.test.ts:67-71` |
| Scenario: `limit` within bounds → paginated constrained result | Done | `src/resources/index.ts:73-92`; test `src/resources/index.test.ts:73-78` |
| Task 1.1 health bypasses bearer auth | Done | `src/transport/middleware.ts:14-17` |
| Task 1.2 tests for /health with & without token | Partial | "with token" covered (`middleware.test.ts:23`, `http.test.ts:131`); explicit "no token configured" path (`middleware.ts:19-23`) not directly asserted |
| Task 1.3 confirm loopback unchanged for health | Partial | Behavior correct by ordering; no dedicated test asserting health blocked when loopback enforcement fails |
| Task 2.1 trusted identity derivation | Done | `src/transport/middleware.ts:77` |
| Task 2.2 bucket eviction/cleanup | Done | `src/transport/middleware.ts:68-75` |
| Task 2.3 header-rotation + eviction tests | Done | `src/transport/middleware.test.ts:42-82` |
| Task 3.1 parse/validate helper with min/max | Done | `src/resources/index.ts:94-118` |
| Task 3.2 INVALID_INPUT for non-numeric/out-of-range | Done | `src/resources/index.ts:96-115` |
| Task 3.3 invalid + valid bounded tests | Done | `src/resources/index.test.ts:61-78` |
| Task 4.1 metrics/logging for rate-limited + bucket cardinality | Done | `setGauge('bhgbrain_rate_limit_buckets')` `src/transport/middleware.ts:87`; `incCounter('bhgbrain_rate_limited_total')` + `logger.warn` `:90-96` |
| Task 4.2 document health/auth policy & limit constraints | Done | `README.md:506,1736,1777-1783,1825,2601-2603` |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | Medium | High | S | Security | `src/transport/http.ts:24-37` | No `app.set('trust proxy', …)`; `req.ip` is socket address, conflicting with design "respecting proxy config" and collapsing proxied clients into one bucket |
| 2 | Medium | High | S | Security | `src/transport/middleware.ts:34` | Bearer token compared with `!==` (non-constant-time); timing side-channel |
| 3 | Medium | Medium | M | Stability | `src/transport/middleware.ts:48-49` | Module-global mutable limiter state shared across all server instances; not per-server, not concurrency-isolated |
| 4 | Medium | Medium | S | Security | `src/transport/middleware.ts:111-124` | Size-limit middleware runs after `express.json()` and trusts client `Content-Length`; streamed/chunked bodies bypass the pre-check |
| 5 | Low | High | S | Stability | `src/transport/http.ts:41-55` | Tool/resource route handlers are `async` with no try/catch; a rejected promise yields an unhandled rejection / hung request (no error middleware) |
| 6 | Low | Medium | S | Maintainability | `src/transport/middleware.ts:77` | `req.ip ?? 'unknown'` lumps all IP-less requests into a single shared bucket |
| 7 | Low | Medium | S | Testing | `src/transport/middleware.ts:128-137` | `validateLoopbackBinding` throw path and "no token configured" auth-skip path are untested |
| 8 | Low | Low | S | Maintainability | `src/transport/http.ts:36-38` | Size-limit middleware is effectively dead given `express.json({ limit })` already enforces the same bound and returns 413 |

## Quick wins

- Add `app.set('trust proxy', <config>)` (or explicitly document loopback-only assumption) so `req.ip` is meaningful and matches the design (Finding 1).
- Switch the bearer-token check to `crypto.timingSafeEqual` with length guard (Finding 2).
- Wrap the async route handlers in try/catch or add an Express error handler (Finding 5).
- Add the two missing tests for loopback-throw and no-token auth-skip (Finding 7).

## Performance

No issues found. The limiter is O(1) per request plus a bounded O(n) sweep at most every 30s; resource listing fetches `limit + 1` rows for has-more detection, which is appropriate.

## Logging & observability

No issues found. Rate-limited requests emit a structured `rate_limited` warn with `trusted_client_id`, `client_hint`, and `limit` (`src/transport/middleware.ts:91-96`); bucket cardinality is exported as a gauge and rejections as a counter (`:87,:90`), satisfying task 4.1. Token previews are redacted via `redactToken` before logging (`src/transport/middleware.ts:35`).

## Stability & reliability

### [Medium · Medium · M] Module-global mutable limiter state shared across all instances — `src/transport/middleware.ts:48-49`
**Issue:** `clientBuckets` and `lastRateLimitSweepAt` are module-level singletons mutated by every `createRateLimitMiddleware` closure. Any two `createHttpServer` invocations in the same process (tests, multi-listener setups, future multi-tenant embedding) share and interfere with one another's rate-limit state, and the test-only `resetRateLimitStateForTests()` (`:51-54`) exists precisely because of this coupling.
**Why it matters:** Shared mutable global state is a latent correctness and test-isolation hazard; it also prevents per-config limits and makes the limiter impossible to instantiate independently.
**Recommendation:** Move the `Map` and sweep timestamp into the factory closure (one per `createRateLimitMiddleware` call) so state is owned by the middleware instance; keep an explicit reset hook on the returned middleware for tests if needed.

### [Low · High · S] Async route handlers without error handling — `src/transport/http.ts:41-55`
**Issue:** `/tool/:name` and `/resource` are `async` handlers (`:41,:48`) that call `handleTool`/`resources.handle` with no try/catch and no registered Express error-handling middleware. In Express 4 a rejected promise from an async handler is not forwarded to error middleware, so a thrown error leaves the request hanging until socket timeout.
**Why it matters:** A single thrown error (e.g. storage failure, bad URL in `resources.handle`) produces a hung connection rather than a clean 500, degrading reliability under fault conditions.
**Recommendation:** Wrap handler bodies in try/catch returning a structured 500, or add an Express error-handling middleware (`(err, req, res, next) => …`) and an async wrapper.

### [Low · Medium · S] IP-less requests collapse into one shared bucket — `src/transport/middleware.ts:77`
**Issue:** `req.ip ?? 'unknown'` assigns every request lacking an IP to the literal key `'unknown'`, so all such requests share a single rate-limit bucket.
**Why it matters:** In normal operation `req.ip` is populated, but if it is ever undefined (custom transports, misconfiguration), unrelated clients would throttle each other. Low likelihood given current loopback usage.
**Recommendation:** Treat a missing `req.ip` as fail-closed (reject) or derive from `req.socket.remoteAddress` before falling back to a shared key.

## Security

### [Medium · High · S] Rate-limit identity uses `req.ip` without `trust proxy` configured — `src/transport/http.ts:24-37`
**Issue:** The design states identity should respect proxy config (`design.md:25`), but `createHttpServer` never calls `app.set('trust proxy', …)`. With the default (`trust proxy` off), `req.ip` is the direct socket peer. That is *safe* against `X-Forwarded-For` spoofing for direct connections, but if BHGBrain is deployed behind any reverse proxy (the realistic non-loopback case the proposal targets), every client collapses to the proxy's single IP — making the limiter trivially self-DoS'ing or ineffective — and there is no config surface to opt into trusting forwarding headers.
**Why it matters:** This is the central abuse-control of the proposal. Without an explicit, configurable trust-proxy decision the limiter is either spoofable (if someone later enables trust proxy blindly) or useless behind a proxy. The current code is correct only for the loopback-only deployment.
**Recommendation:** Add an explicit `security.trust_proxy` config (default `false`), call `app.set('trust proxy', config.security.trust_proxy)`, and document that the rate limiter is loopback-accurate only. This closes the gap between `design.md:25` and the implementation.

### [Medium · High · S] Non-constant-time bearer token comparison — `src/transport/middleware.ts:34`
**Issue:** `match[1] !== expectedToken` compares the supplied token to the configured secret with JS string inequality, which short-circuits on the first differing byte.
**Why it matters:** This is a timing side-channel on the auth secret. While remote exploitation over a network is noisy, the proposal explicitly hardens the HTTP surface and the fix is trivial; constant-time comparison is the expected standard for secret checks.
**Recommendation:** Use `crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))` guarded by an equal-length check (compare hashes of equal length if lengths may differ).

### [Medium · Medium · S] Size limit trusts client `Content-Length` and runs after body parsing — `src/transport/middleware.ts:111-124`
**Issue:** `createSizeLimitMiddleware` reads `req.headers['content-length']` and compares to `max_request_size_bytes`. A request with a missing/incorrect `Content-Length` (chunked transfer-encoding) bypasses this pre-check. It is also registered (`http.ts:38`) *after* `express.json({ limit })` (`http.ts:26`), so the actual enforcement is already done by the body parser and this middleware adds no real protection on the `/tool` JSON path.
**Why it matters:** The middleware gives a false sense of an independent guard; the real bound comes from `express.json`. For non-JSON or streamed routes (none today, but a maintenance trap) the header check is bypassable.
**Recommendation:** Rely on `express.json({ limit })` as the authoritative bound (it streams and counts actual bytes), and either remove the header-based middleware or convert it to a hard pre-route reject that does not trust `Content-Length` alone. See also Finding 8.

## Maintainability & code quality

### [Low · Medium · S] IP-less bucket key magic string — `src/transport/middleware.ts:77`
Covered under Stability (Finding 6); the `'unknown'` sentinel mixes a security identity with a literal fallback and should be a named constant or fail-closed path.

### [Low · Low · S] Size-limit middleware is effectively redundant — `src/transport/http.ts:36-38`
**Issue:** `express.json({ limit: config.security.max_request_size_bytes })` (`http.ts:26`) already enforces the byte bound and returns 413 on oversize JSON before the custom `createSizeLimitMiddleware` (`http.ts:38`) ever runs meaningfully.
**Why it matters:** Two mechanisms enforcing the same limit with different trust models (actual bytes vs. client header) invites drift and confusion about which is authoritative.
**Recommendation:** Consolidate on the body-parser limit; if a non-JSON path is anticipated, document the size middleware's role explicitly, otherwise remove it.

## Testing & coverage

### [Low · Medium · S] Loopback-throw and no-token auth-skip paths untested — `src/transport/middleware.ts:128-137`
**Issue:** `validateLoopbackBinding`'s throw branch (`:132-136`, directly tied to spec scenario "startup fails before serving any route") has no test, and the auth middleware's "no token configured → skip with warn" branch (`:19-23`, task 1.2's implicit case) is not asserted.
**Why it matters:** These are exactly the security-relevant boundary behaviors the proposal hardens; leaving them untested risks silent regressions of the spec scenarios.
**Recommendation:** Add a unit test asserting `validateLoopbackBinding` throws for a non-loopback host with `require_loopback_http=true`, and one asserting the auth middleware calls `next()` and logs `auth_skip` when no token env is set.

## Dependencies & supply chain

No issues found. The change introduces no new dependencies; it uses Express, Pino, and the existing metrics collector already present in the project. (Note: the timing-safe-compare recommendation in Finding 2 uses Node's built-in `crypto`, no new dependency.)

## Recommendations (prioritized)

1. **Add explicit `trust proxy` configuration** (`security.trust_proxy`, default false) and wire it in `createHttpServer`, reconciling code with `design.md:25` and documenting loopback-only accuracy (Finding 1).
2. **Use constant-time bearer-token comparison** via `crypto.timingSafeEqual` (Finding 2).
3. **Encapsulate limiter state in the factory closure** instead of module globals to remove shared mutable state and the test-only reset coupling (Finding 3).
4. **Add error handling for async routes** (try/catch or Express error middleware) so faults return 500 instead of hanging (Finding 5).
5. **Consolidate request-size enforcement** on `express.json({ limit })` and remove/repurpose the header-trusting size middleware (Findings 4, 8).
6. **Close test gaps** for loopback-throw and no-token auth-skip, plus IP-less fail-closed handling (Findings 6, 7).
