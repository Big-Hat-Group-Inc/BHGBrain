## MODIFIED Requirements

### Requirement: Health endpoints SHALL report overall and component states
`GET /health` and `health://status` SHALL return overall status and individual component statuses
for `sqlite`, `qdrant`, and `embedding`. The `qdrant` component status SHALL be derived from an
operation that exercises the vector retrieval path, and SHALL NOT be derived solely from a
connectivity or metadata call such as listing collections.

#### Scenario: Healthy system reports healthy states
- **WHEN** all core components are available
- **THEN** overall status is `healthy` and each component status is healthy

#### Scenario: Partial outage reports degraded state
- **WHEN** embedding is unavailable while storage components remain available
- **THEN** overall status is `degraded` with embedding marked unavailable

#### Scenario: Reachable but unqueryable vector store is not healthy
- **WHEN** the vector store accepts connections and responds to metadata calls
- **AND** the vector retrieval call fails
- **THEN** the `qdrant` component status is not healthy
- **AND** overall status is not `healthy`

#### Scenario: Write availability does not mask a broken read path
- **WHEN** vector writes continue to succeed
- **AND** vector retrieval fails
- **THEN** health reports the `qdrant` component as not healthy
- **AND** a growing stored-memory count does not cause the component to be reported healthy

#### Scenario: An empty vector store is healthy
- **WHEN** the vector retrieval probe executes successfully and returns zero results
- **THEN** the `qdrant` component status is healthy

#### Scenario: A missing collection is healthy
- **WHEN** the vector retrieval probe targets a collection that does not exist
- **THEN** the `qdrant` component status is healthy
- **AND** the absent collection is not reported as a retrieval failure

### Requirement: Health probes SHALL be bounded and side-effect free
Health probes SHALL NOT create, update, or delete data, and SHALL bound the work they request from
backing stores so that repeated polling of an unauthenticated health endpoint does not impose
unbounded cost.

#### Scenario: Probing does not mutate state
- **WHEN** a health probe runs against the vector store
- **THEN** no collection is created, modified, or deleted
- **AND** no points are written

#### Scenario: Probe work is bounded
- **WHEN** a health probe issues a retrieval call
- **THEN** the call requests a bounded result set
- **AND** the probe does not hydrate payloads it does not need
