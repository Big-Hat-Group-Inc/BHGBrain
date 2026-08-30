## Why

Net-new security findings from the audits of the completed `harden-http-health-rate-limit-and-resource-bounds` and `address-codereview-issues` changes (which share the same auth/middleware code) surfaced defense-in-depth gaps in the HTTP transport. The bearer-token check compares secrets with a non-constant-time `!==` (`src/transport/middleware.ts:34`), creating a timing side-channel. The rate limiter keys on `req.ip` without Express `trust proxy` configured, contradicting the original design's "respecting proxy config" intent (`design.md:25`) and silently collapsing all proxied clients into a single bucket. Limiter state is held in module-global mutable maps, so independent server instances and tests share and interfere with one another's buckets. While the documented deployment is loopback-only (reducing real-world exposure), the constant-time comparison is a near-free must-fix and the proxy/identity and state-scoping issues remove latent hazards before any non-loopback deployment.

## What Changes

- Replace the bearer-token equality check with a constant-time comparison (e.g. `crypto.timingSafeEqual` guarded by a length check) so token verification no longer leaks byte-position timing.
- Add explicit, configurable proxy-trust handling so rate-limit client identity is derived correctly: configure Express `trust proxy` from config (default off / loopback-only) and document that the limiter is loopback-accurate unless proxy trust is enabled.
- Derive a safe client identity for rate limiting, treating a missing `req.ip` as fail-closed rather than collapsing into a single shared `'unknown'` bucket.
- Move rate-limiter state (bucket map and sweep timestamp) into per-middleware/per-server instance scope instead of module globals so multiple server instances and tests do not share buckets, removing the test-only global reset coupling.
- Add tests covering constant-time comparison behavior, proxy-trust identity derivation, and instance-scoped limiter isolation.

## Capabilities

### New Capabilities
- `http-auth-hardening`: Constant-time bearer-token verification, correct proxy-aware rate-limit client identity with configurable `trust proxy`, and instance-scoped (non-module-global) rate-limiter state.

### Modified Capabilities
- None.

## Impact

- Affected code: `src/transport/middleware.ts`, `src/transport/http.ts`, `src/config/index.ts` (new `security.trust_proxy` option), related tests.
- API behavior: unchanged success/failure status codes; auth and rate limiting become hardened against timing side-channels and proxy-induced misattribution.
- Security/ops: removes a timing side-channel on the auth secret and a rate-limit misattribution risk; framed as defense-in-depth over the existing loopback-only deployment posture.
- Docs: `README.md`, `.env.example`, and `AGENTS.md` updated for the new `trust_proxy` config and loopback-accuracy note.
