## 1. Strengthen the vector-store probe

- [ ] 1.1 Replace the connectivity-only body of `QdrantStore.healthCheck()` (`src/storage/qdrant.ts:218-225`) with a bounded, read-only retrieval call issued through the same client method the search path uses.
- [ ] 1.2 Treat an empty result as healthy and a raised failure as unhealthy, so a fresh install with zero memories reports healthy.
- [ ] 1.3 Treat "collection does not exist" as healthy, reusing the `isNotFoundError` handling already applied in the fan-out path (`src/storage/qdrant.ts:176-179`).
- [ ] 1.4 Keep the probe side-effect free: no upsert, create, or delete, and no payload hydration.

## 2. Health service wiring

- [ ] 2.1 Confirm the probe call site at `src/health/index.ts:72` still maps a `false` result to a non-healthy `qdrant` component and that `computeOverall` (`src/health/index.ts:144-153`) degrades overall status accordingly.
- [ ] 2.2 Confirm the failure reason reaches structured logs so an operator can tell a retrieval failure from a connectivity failure.

## 3. Regression coverage

- [ ] 3.1 Add a test where the client is reachable (`getCollections` succeeds) but the retrieval call throws, asserting `qdrant` is reported non-healthy and overall status is not `healthy`. This is the exact shape of the 1.19 outage.
- [ ] 3.2 Add a test asserting an empty result set reports healthy.
- [ ] 3.3 Add a test asserting a missing collection reports healthy.
- [ ] 3.4 Confirm the existing expectation at `src/health/index.test.ts:208-216` (qdrant unavailable -> unhealthy) still holds.

## 4. Validation

- [ ] 4.1 Run `npm run lint`, `npm test`, and `npm run build`.
- [ ] 4.2 Verify against a live instance that revoking the vector-store credential, or otherwise breaking the query path while leaving the server reachable, produces a non-healthy `qdrant` component in both `GET /health` and `health://status`.
- [ ] 4.3 Verify a healthy instance with zero stored memories still reports `status: healthy`.
