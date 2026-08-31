## Why

Operational and security audit findings show that health checks are unintentionally blocked by auth middleware, rate limiting trusts caller-controlled IDs and leaks memory over time, and resource listing accepts unbounded limits. These gaps reduce reliability under normal operations and weaken abuse resistance.

## What Changes

- Make `/health` accessible according to explicit policy and independent from general tool auth defaults.
- Strengthen rate limiting identity and storage lifecycle to resist bypass and memory growth.
- Enforce validation/clamping for resource list `limit` inputs across transport/resource interfaces.
- Add consistent error contracts for invalid bounds and rate-limited requests.

## Capabilities

### New Capabilities
- `health-endpoint-auth-policy`: Enforce explicit auth exemption policy for health checks.
- `rate-limit-trust-and-eviction`: Use trusted identity derivation and bounded in-memory limiter state.
- `resource-pagination-bounds`: Validate and bound resource list limits.

### Modified Capabilities
- None.

## Impact

- Affected code: `src/transport/http.ts`, `src/transport/middleware.ts`, `src/resources/index.ts`, related schema/config surfaces.
- API behavior: predictable health probe availability, deterministic 400/429 behavior for invalid or abusive requests.
- Security/ops: improved abuse controls and reduced long-lived memory pressure.
