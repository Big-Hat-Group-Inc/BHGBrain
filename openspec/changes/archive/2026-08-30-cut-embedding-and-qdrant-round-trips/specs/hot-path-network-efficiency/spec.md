## ADDED Requirements

### Requirement: Embedding requests SHALL honor configured timeout and retry uniformly across providers
Every embedding API request, regardless of provider (`openai` or `azure-foundry`),
SHALL be bounded by `embedding.request_timeout_ms` per attempt and SHALL retry
transient failures (timeouts, network errors, HTTP 429, HTTP 5xx) with exponential
backoff up to `embedding.retry.max_attempts`, with non-retryable client errors
(400/401/403/404 and other 4xx) failing immediately. The whole retry loop SHALL
execute within a single circuit-breaker invocation so one logical operation records
at most one breaker failure.

#### Scenario: Stalled OpenAI connection is bounded
- **WHEN** the OpenAI embeddings endpoint accepts a connection but never responds
- **THEN** the attempt SHALL be aborted at `request_timeout_ms`
- **AND** the operation SHALL fail (after retries are exhausted) with a structured
  retryable error instead of hanging for the HTTP client's default timeout

#### Scenario: Transient failure is retried
- **WHEN** an embedding request receives HTTP 503 and a subsequent attempt succeeds
  within `retry.max_attempts`
- **THEN** the operation SHALL succeed
- **AND** the circuit breaker SHALL record no failure for the operation

#### Scenario: Non-retryable client error fails fast
- **WHEN** an embedding request receives HTTP 401
- **THEN** the operation SHALL fail without further attempts

#### Scenario: Health probe stays single-shot
- **WHEN** an embedding provider health check runs
- **THEN** it SHALL issue one attempt bounded by `request_timeout_ms`
- **AND** SHALL NOT retry or engage the circuit breaker

### Requirement: Collection existence SHALL be ensured at most once per collection per process
The vector store SHALL memoize collections it has successfully ensured and skip the
ensure round trips on subsequent writes to the same collection, invalidating the memo
when the collection is deleted locally or found missing during a write.

#### Scenario: Repeat writes skip ensure round trips
- **WHEN** a second memory is written to a collection already ensured by this process
- **THEN** no collection-existence or index-creation requests SHALL be issued for it

#### Scenario: Externally deleted collection self-heals
- **WHEN** a write targets a memoized collection that no longer exists on the server
- **THEN** the store SHALL invalidate the memo, re-ensure the collection, and retry
  the write exactly once

#### Scenario: Partial ensure failure is not memoized
- **WHEN** the ensure sequence fails partway (e.g. an index creation errors)
- **THEN** the collection SHALL NOT be memoized
- **AND** the next write SHALL retry the full ensure sequence

### Requirement: The collection list SHALL be cached with bounded staleness
Namespace-wide search SHALL reuse a cached collection list within a short TTL, with
eager invalidation whenever this process creates or deletes a collection.

#### Scenario: Repeated searches share one list fetch
- **WHEN** two namespace-wide searches run within the TTL window
- **THEN** exactly one collection-list request SHALL be issued

#### Scenario: Local mutation invalidates eagerly
- **WHEN** this process creates or deletes a collection
- **THEN** the next namespace-wide search SHALL fetch a fresh collection list even
  within the TTL window

### Requirement: Query embeddings SHALL be cached for the read path only
Recall/search SHALL serve repeated identical query embeddings from a bounded
in-process LRU keyed by the embedding provider identity, and vector-producing writes
SHALL never receive a cached embedding.

#### Scenario: Repeated query hits the cache
- **WHEN** the same query string is recalled twice under the same embedding identity
- **THEN** the second recall SHALL NOT call the embedding provider for that query

#### Scenario: Identity change misses
- **WHEN** the embedding provider, model, or dimensions change
- **THEN** previously cached query embeddings SHALL NOT be served for the new identity

#### Scenario: Writes bypass the cache
- **WHEN** a memory whose content equals a previously recalled query is stored
- **THEN** its content embedding SHALL be produced by a fresh provider call

#### Scenario: Failures are not cached
- **WHEN** an embed attempt for a query fails
- **THEN** no cache entry SHALL be created
- **AND** the next recall of that query SHALL attempt the provider again

### Requirement: Hybrid search legs SHALL overlap
Hybrid search SHALL dispatch the query-embedding request before running the fulltext
scan so the two legs execute concurrently, preserving existing degraded-fallback
semantics.

#### Scenario: Legs run concurrently
- **WHEN** a hybrid search executes with a healthy embedding provider
- **THEN** the embedding request SHALL be in flight before the fulltext scan begins
- **AND** results SHALL be identical to the serialized implementation

#### Scenario: Degraded fallback preserved
- **WHEN** the embedding request fails while the fulltext scan runs
- **THEN** hybrid search SHALL return fulltext-only results, set the degraded signal,
  and emit the existing degradation metric and warning
- **AND** no unhandled promise rejection SHALL occur
