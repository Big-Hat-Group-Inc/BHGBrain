# Make vector-store health reflect the read path

## Why

During the `@qdrant/js-client-rest` 1.19 outage (see `fix-qdrant-client-search-removal`), every
`recall` and `search` call failed with `this.client.search is not a function` while
`bhgbrain health` reported:

```json
{ "status": "healthy",
  "components": { "sqlite": "healthy", "qdrant": "healthy", "embedding": "healthy", ... } }
```

The health report was not merely unhelpful, it was actively misleading: an operator checking
health during a total retrieval outage is told the vector store is fine.

The cause is that `QdrantStore.healthCheck()` (`src/storage/qdrant.ts:218-225`) probes only
`client.getCollections()`. That verifies reachability, credentials, and TLS - and nothing about
whether vectors can actually be queried. Any defect in the retrieval call itself (a removed client
method, an incompatible request shape, a server-side query rejection, a filter or index problem)
is invisible to the probe, because the probe never issues a query.

The existing contract in `observability-health` says health SHALL report a component status for
`qdrant`, but does not say what that status must be derived from. A connectivity ping technically
satisfies it. That gap is what let a green health report coexist with a fully broken read path.

This matters most in exactly the situation health checks exist for: writes continued to succeed
throughout, so memory count and Qdrant point count both kept climbing while nothing could be read
back. Health was the one signal that should have caught it.

## What Changes

- Require the `qdrant` component status to be derived from an operation that exercises the vector
  retrieval path, not solely from a connectivity or metadata call.
- Require a retrieval-path failure to be reported as a non-healthy `qdrant` component status and
  to degrade overall status accordingly.
- Keep the probe cheap and side-effect free, so health remains safe to poll.
- Add coverage asserting that a store which is reachable but cannot serve queries is not reported
  as healthy.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `observability-health`: strengthens "Health endpoints SHALL report overall and component states"
  so the `qdrant` component status reflects retrieval capability rather than mere reachability.

## Impact

- Affected code: `src/storage/qdrant.ts` (`healthCheck`), `src/health/index.ts:72` (probe call
  site), `src/health/index.test.ts`, `src/storage/qdrant.test.ts`.
- Affected behavior: `GET /health` and `health://status` report `qdrant` as degraded or unhealthy
  when vectors cannot be queried, even while the server is reachable. No change when the store is
  fully functional.
- Affected specs: modifies `observability-health`.
- Risk: low to moderate - a retrieval probe is a heavier call than `getCollections()`. The probe
  must stay bounded and read-only so that frequent polling does not add meaningful load, and must
  not report unhealthy merely because a namespace is empty.
- Related: `fix-qdrant-client-search-removal` fixes the underlying outage; this change ensures the
  next one is visible.
