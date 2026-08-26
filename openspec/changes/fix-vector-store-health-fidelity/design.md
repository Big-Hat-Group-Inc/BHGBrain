## Context

`HealthService` composes component states from three probes (`src/health/index.ts:23-31`). The
Qdrant probe (`src/health/index.ts:72`) delegates to `QdrantStore.healthCheck()`, which is:

```ts
async healthCheck(): Promise<boolean> {
  try { await this.client.getCollections(); return true; } catch { return false; }
}
```

`getCollections()` answers "can I reach the server and authenticate". It cannot answer "can I
retrieve vectors", which is the only thing the vector store exists to do. During the 1.19 client
outage the process could list collections perfectly while every query threw, so the probe returned
`true` and overall status stayed `healthy`.

The same blind spot covers a wider class of faults than the one that exposed it: a server-side
rejection of the query body, a payload-index regression that breaks filtering, a dimension
mismatch after an embedding-model change, or a collection in a non-green state. All are reachable
and all are unqueryable.

## Goals / Non-Goals

**Goals:**
- Make the `qdrant` component status mean "retrieval works", not "the server answers".
- Ensure a read-path outage degrades overall health while writes continue to succeed.
- Keep the probe bounded, read-only, and cheap enough for frequent polling.

**Non-Goals:**
- Changing the overall-status aggregation rules in `computeOverall`
  (`src/health/index.ts:144-153`).
- Adding a health probe for the embedding provider beyond what already exists.
- Making health checks write, upsert, or mutate any collection.
- Guaranteeing detection of every possible server-side fault - the goal is to cover the retrieval
  call path, not to replace end-to-end monitoring.

## Decisions

1. Probe the retrieval path, not just connectivity.
- Decision: `healthCheck()` SHALL issue a bounded, read-only retrieval call through the same client
  method the search path uses, and treat a failure of that call as unhealthy.
- Rationale: a probe that does not exercise the failing call cannot detect the failure. Using the
  same client method the read path uses is what makes the signal meaningful.
- Alternative considered: keep `getCollections()` and add a separate "retrieval" component.
  Rejected because operators read the `qdrant` component as "is my vector store working", and a
  second component invites the same misreading.

2. Distinguish "no data" from "cannot query".
- Decision: an empty result from the probe SHALL be healthy. Only a raised failure is unhealthy.
- Rationale: a new install with zero memories must not report unhealthy. The signal is whether the
  query executes, not what it returns.
- Alternative considered: assert a minimum point count. Rejected - it would report unhealthy on
  every fresh deployment.

3. Keep the probe bounded and side-effect free.
- Decision: the probe SHALL use a minimal limit and SHALL NOT write, upsert, create, or delete.
- Rationale: `/health` is unauthenticated (`harden-http-health-rate-limit-and-resource-bounds`) and
  pollable, so probe cost is attacker-influenced. A bounded read keeps that acceptable.
- Alternative considered: cache the probe result for a short interval. Deferred - worth doing if
  polling load proves material, but it trades away signal freshness and is not required for
  correctness here.

4. Degrade rather than fail hard when the store is reachable but unqueryable.
- Decision: reuse the existing component-status vocabulary and let `computeOverall` aggregate; do
  not introduce a new terminal state.
- Rationale: the aggregation rules are already specified and tested; this change is about the
  fidelity of one input, not about the aggregation.
- Alternative considered: a distinct `unqueryable` status. Rejected as unnecessary vocabulary
  growth.

## Risks / Trade-offs

- A retrieval probe costs more than a metadata call. Mitigated by a minimal limit and no payload
  hydration; revisit with caching if polling load becomes material.
- If the probe targets a specific namespace or collection, it may report unhealthy when that
  collection simply does not exist yet. The probe must treat "collection absent" the same as
  "empty result" - healthy - consistent with the `isNotFoundError` handling already used in the
  fan-out path (`src/storage/qdrant.ts:176-179`).
- Health becomes a slightly stronger contract, so a previously green deployment with a latent
  retrieval fault will start reporting degraded. That is the intended outcome, but it will look
  like a regression to anyone who was relying on the old signal.
