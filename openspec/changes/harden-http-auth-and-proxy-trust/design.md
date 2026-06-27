## Context

The HTTP transport's auth and rate-limit middleware (`src/transport/middleware.ts`) was hardened by two prior, now-complete changes (`harden-http-health-rate-limit-and-resource-bounds` and `address-codereview-issues`). Subsequent code audits of those changes (`codeaudit/harden-http-health-rate-limit-and-resource-bounds-2026-06-05-02-19.md` and `codeaudit/address-codereview-issues-2026-06-05-02-19.md`) surfaced three net-new findings in the same code:

1. The bearer-token check uses JS string inequality (`match[1] !== expectedToken`, `src/transport/middleware.ts:34`), which short-circuits on the first differing byte — a timing side-channel on the auth secret.
2. The rate limiter keys on `req.ip` (`src/transport/middleware.ts:77`) but `createHttpServer` never sets Express `trust proxy`. This contradicts the original proposal's design Decision 2 ("respecting proxy config", `design.md:25`): with trust proxy off, every client behind a reverse proxy collapses into the proxy's single IP bucket, and there is no config surface to opt into trusting forwarding headers.
3. Limiter state (`clientBuckets`, `lastRateLimitSweepAt`, `src/transport/middleware.ts:48-49`) is module-global mutable state shared by every `createRateLimitMiddleware` closure, so independent server instances and tests interfere — the existing `resetRateLimitStateForTests` hook exists precisely to paper over this coupling.

The project's documented and intended deployment is **loopback-only** (`security.require_loopback_http` defaults true; `validateLoopbackBinding` enforces it). That materially reduces real-world exposure of all three findings, so this change is framed as defense-in-depth hardening rather than incident response. The constant-time comparison is the one unambiguous must-fix because it is near-free and is the standard expectation for secret verification.

## Goals / Non-Goals

**Goals:**
- Eliminate the timing side-channel in bearer-token verification via constant-time comparison.
- Reconcile the rate limiter with the original design's proxy-trust intent through an explicit, configurable `trust proxy` setting and safe client-identity derivation.
- Make rate-limiter state instance/server-scoped so multiple instances and tests are isolated.

**Non-Goals:**
- Changing the loopback-only default deployment posture.
- Introducing distributed/shared rate limiting across processes.
- Re-architecting authentication (no API keys, OAuth, or role model changes).
- Addressing unrelated audit findings (size-limit middleware redundancy, async route error handling, FTS5, structured content) — those are out of scope here.

## Decisions

1. **Constant-time bearer-token comparison.**
   - Decision: Replace `!==` with `crypto.timingSafeEqual` over equal-length `Buffer`s, guarded by a length check so unequal-length inputs fail closed without throwing (and without leaking length via early return timing differences beyond the unavoidable length signal).
   - Rationale: Constant-time comparison is the standard for secret verification; the fix is small and removes the side-channel regardless of deployment.
   - Alternative considered: leave as-is given loopback-only deployment. Rejected — the fix is near-free and the hardening changes explicitly target the auth surface.

2. **Explicit, configurable `trust proxy`.**
   - Decision: Add `security.trust_proxy` (default `false`) and call `app.set('trust proxy', config.security.trust_proxy)` in `createHttpServer`. Document that the limiter is loopback-accurate unless proxy trust is enabled.
   - Rationale: Closes the gap between the original design Decision 2 and the implementation; makes the trust decision explicit rather than an implicit default, avoiding both proxy-collapse (limiter useless) and blind `X-Forwarded-For` trust (limiter spoofable).
   - Alternative considered: hardcode trust proxy on/off. Rejected — neither is universally correct; the deployment owner must choose.

3. **Fail-closed client identity.**
   - Decision: Derive the rate-limit key from `req.ip` and treat a missing IP as fail-closed (reject) rather than mapping to a shared `'unknown'` bucket.
   - Rationale: Prevents unrelated IP-less clients from throttling one another and removes a magic-string security identity.

4. **Instance-scoped limiter state.**
   - Decision: Move the bucket `Map` and sweep timestamp into the `createRateLimitMiddleware` factory closure; expose any reset/inspection hook on the returned middleware instance instead of a module-global function.
   - Rationale: Removes shared mutable global state, enables per-config/per-instance limiters, and fixes test isolation without the module-global reset hack.

## Risks / Trade-offs

- [Constant-time comparison still leaks token length] -> Mitigation: lengths differing is an inherent, low-value signal; the length guard itself is acceptable and standard. Avoid logging or branching on content beyond the guard.
- [Enabling `trust proxy` blindly re-introduces `X-Forwarded-For` spoofing] -> Mitigation: default `false`, document that it must only be enabled behind a trusted proxy that sets forwarding headers correctly.
- [Fail-closed missing-IP rejection could block legitimate exotic transports] -> Mitigation: `req.ip` is populated for all standard HTTP paths; the loopback-only default makes the missing-IP case effectively unreachable in normal operation.
- [Refactoring limiter state could change reset semantics relied on by existing tests] -> Mitigation: provide an equivalent instance-scoped reset and update tests in the same change.

## Migration Plan

- Add `security.trust_proxy` to the Zod config schema with a `false` default; existing config files load unchanged (default applies).
- Wire `app.set('trust proxy', …)` and the hardened comparison/identity/state changes behind no new runtime flags — behavior is unchanged for the default loopback deployment.
- Update tests to construct instance-scoped limiters; replace `resetRateLimitStateForTests` usage.
- Rollback: revert the middleware/config changes; no persisted data or schema migration is involved.

## Open Questions

- Should `security.trust_proxy` accept the full Express trust-proxy value range (boolean, number of hops, subnet list, function) or a constrained subset for safety?
- When `req.ip` is missing, should the response be `400 INVALID_INPUT` or `429 RATE_LIMITED`, and should this be logged distinctly for diagnosis?
