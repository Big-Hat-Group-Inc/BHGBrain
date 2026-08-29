## 1. Strengthen the vector-store probe

- [x] 1.1 Replace the connectivity-only body of `QdrantStore.healthCheck()` (`src/storage/qdrant.ts:218-225`) with a bounded, read-only retrieval call issued through the same client method the search path uses.
- [x] 1.2 Treat an empty result as healthy and a raised failure as unhealthy, so a fresh install with zero memories reports healthy.
- [x] 1.3 Treat "collection does not exist" as healthy, reusing the `isNotFoundError` handling already applied in the fan-out path (`src/storage/qdrant.ts:176-179`).
- [x] 1.4 Keep the probe side-effect free: no upsert, create, or delete, and no payload hydration.

## 2. Health service wiring

- [x] 2.1 Confirm the probe call site at `src/health/index.ts:72` still maps a `false` result to a non-healthy `qdrant` component and that `computeOverall` (`src/health/index.ts:144-153`) degrades overall status accordingly.
- [x] 2.2 Confirm the failure reason reaches structured logs so an operator can tell a retrieval failure from a connectivity failure. (Correction: this box was previously checked but the premise did not hold — `HealthService` had no logger wired in at all, so the qdrant failure `message` only ever reached the `/health` JSON body, never Pino. Fixed: added an optional `logger` param to `HealthService`, wired from `src/index.ts` and `src/cli/index.ts`; `checkQdrant()` now emits `logger.warn({ event: 'qdrant_health_check_failed', message })` on failure, carrying the raw error text that already distinguishes a retrieval-path failure like "this.client.query is not a function" from a connectivity failure like ECONNREFUSED. Covered by a new test in `src/health/index.test.ts`.)

## 3. Regression coverage

- [x] 3.1 Add a test where the client is reachable (`getCollections` succeeds) but the retrieval call throws, asserting `qdrant` is reported non-healthy and overall status is not `healthy`. This is the exact shape of the 1.19 outage.
- [x] 3.2 Add a test asserting an empty result set reports healthy.
- [x] 3.3 Add a test asserting a missing collection reports healthy.
- [x] 3.4 Confirm the existing expectation at `src/health/index.test.ts:208-216` (qdrant unavailable -> unhealthy) still holds.

## 4. Validation

- [x] 4.1 Run `npm run lint`, `npm test`, and `npm run build`.
- [x] 4.2 Verify against a live instance that revoking the vector-store credential, or otherwise breaking the query path while leaving the server reachable, produces a non-healthy `qdrant` component in both `GET /health` and `health://status`. _(2026-08-28: live-verified in a disposable WSL2 Ubuntu 24.04 sandbox with real Docker-hosted Qdrant 1.19.0 (no credential-auth configured on this instance, so the query path was broken the other documented way — "otherwise breaking the query path while leaving the server reachable" — by recreating the collection with mismatched vector dimensions, `4` instead of the configured `1536`). Ran the built server (`node dist/index.js`) with `BHGBRAIN_QDRANT_URL` pointed at the live instance. `getCollections()`-level connectivity remained fine (server reachable), but the bounded retrieval probe's `client.query()` call was rejected by Qdrant with a genuine `Bad Request` (dimension mismatch) — not a not-found error. `GET /health` returned `"qdrant":{"status":"unhealthy","message":"Bad Request"}` and overall `"status":"degraded"`. This is exactly the fidelity gap the proposal fixes: the old connectivity-only check would have reported this instance healthy.)_
- [x] 4.3 Verify a healthy instance with zero stored memories still reports `status: healthy`. _(2026-08-28: same live sandbox. Created the `bhgbrain_global_general` collection with the correct 1536-dim config and zero points, started the server against it. `GET /health` returned `"qdrant":{"status":"healthy"}` with `"memory_count":0` and overall `"status":"degraded"` only because of the (expected, unrelated) missing-embedding-credentials component — the qdrant component itself was clean `healthy`.)_
