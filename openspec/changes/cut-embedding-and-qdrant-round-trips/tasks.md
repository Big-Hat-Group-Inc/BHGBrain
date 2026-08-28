## 1. Shared embedding request helper (timeout/retry parity)

- [ ] 1.1 Create `src/embedding/request.ts`: extract the Azure provider's per-attempt
  `AbortController` timeout (`src/embedding/azure-foundry.ts:170-196`,
  `executeSingleRequest`), retry-with-exponential-backoff and status classification
  (`:120-168`, `requestWithRetry`: 429 → `rateLimited`, 5xx retryable
  `embeddingUnavailable`, 400/401/403/404 and other 4xx non-retryable `BrainError`),
  and retryable-error predicate (`:208-216`, `isRetryableError`) into a shared
  function parameterized by `{ url, headers, body, timeoutMs, retry, breaker,
  useBreaker, errorPrefix }`. Preserve breaker-wraps-all-attempts semantics (one
  `breaker.execute` around the whole retry loop).
- [ ] 1.2 Wire `OpenAIEmbeddingProvider` (`src/embedding/index.ts:37-121`) to the
  helper: read `config.embedding.request_timeout_ms` (`src/config/index.ts:46`) and
  `config.embedding.retry.{max_attempts,backoff_ms}` (`src/config/index.ts:48-51`)
  in the constructor; replace the bare-fetch `requestEmbeddings`
  (`src/embedding/index.ts:87-105`) with helper calls from `embedBatch` (`:65-75`).
- [ ] 1.3 Keep `OpenAIEmbeddingProvider.healthCheck` (`src/embedding/index.ts:77-85`)
  single-shot — bounded by `request_timeout_ms`, no retry, no breaker — matching the
  Azure probe (`src/embedding/azure-foundry.ts:103-113`) and the contract documented
  at `README.md:3178`.
- [ ] 1.4 Refactor `AzureFoundryEmbeddingProvider` onto the shared helper with no
  observable behavior change (same statuses, same backoff `backoff_ms × 2^(attempt−1)`,
  same breaker interaction); existing tests in `src/embedding/azure-foundry.test.ts`
  pass without semantic edits.
- [ ] 1.5 Tests (`src/embedding/index.test.ts` + a co-located test for the helper):
  OpenAI request aborts at `request_timeout_ms` (fake timers); transient 5xx/429
  retries up to `max_attempts` then surfaces the classified error; 401 fails
  immediately without retry; one `embedBatch` with internal retries records at most
  one breaker failure.

## 2. Qdrant ensured-collection memoization

- [ ] 2.1 Add a private `ensuredCollections: Set<string>` to `QdrantStore`
  (`src/storage/qdrant.ts:21`); `ensureCollection` (`:51-92`) returns early on a
  cache hit and adds the name only after the full sequence (get-or-create + payload
  indexes + `ensureDeviceIdIndex` `:94-104`) succeeds.
- [ ] 2.2 Invalidate the entry in `deleteCollection` (`src/storage/qdrant.ts:332-343`)
  and clear the whole set in `clearManagedCollections` (`:423-441`).
- [ ] 2.3 In `upsert` (`src/storage/qdrant.ts:106-125`): on a not-found error from
  `client.upsert`, drop the memoized entry, re-run `ensureCollection`, retry the
  upsert exactly once; a second not-found propagates.
- [ ] 2.4 Tests (`src/storage/qdrant.test.ts`): second `upsert` to the same collection
  issues no `getCollection`/`createPayloadIndex` calls; delete → upsert re-ensures;
  not-found during upsert triggers invalidate + re-ensure + single retry; partial
  ensure failure (index call rejects) leaves the name un-memoized so the next call
  retries the sequence.

## 3. Collection-list TTL cache

- [ ] 3.1 Cache `listAllCollections` (`src/storage/qdrant.ts:354-359`) results for a
  short internal TTL constant (~5000 ms); eagerly invalidate on collection creation
  inside `ensureCollection`, on `deleteCollection`, and on `clearManagedCollections`.
- [ ] 3.2 Confirm namespace-wide `search` (`src/storage/qdrant.ts:199`) and the
  callers in `src/storage/index.ts:423`/`:473` and `src/tools/index.ts:574` observe
  eager invalidation after local create/delete (no stale-window test flakiness).
- [ ] 3.3 Tests: two namespace-wide searches within the TTL issue one
  `getCollections`; a local `deleteCollection` between them forces a refetch; TTL
  expiry (fake timers) forces a refetch.

## 4. Query-embedding LRU (read path only)

- [ ] 4.1 Implement a ~256-entry LRU keyed by
  `` `${embedding.identity} ${query}` `` as a private `embedQuery` on
  `SearchService` (`src/search/index.ts:69`), used by `semanticSearch`
  (`src/search/index.ts:146`) and `hybridSearch` (`:214`) only. Never cache a failed
  embed. Record `query_embedding_cache_hit`/`query_embedding_cache_miss` via the
  existing `MetricsCollector.incCounter` (`src/health/metrics.ts:78`).
- [ ] 4.2 Verify write-path call sites remain uncached (direct provider calls):
  `src/pipeline/index.ts:121`, `src/storage/index.ts:260`, `src/storage/index.ts:698`,
  `src/backup/retention.ts:380`, `src/tools/index.ts:436`.
- [ ] 4.3 Tests (`src/search/index.test.ts`): repeat identical query embeds once;
  distinct queries embed separately; eviction beyond capacity; a changed provider
  identity misses (no cross-space vector reuse); a rejected embed is not cached and
  the next call retries.

## 5. Parallel hybrid legs

- [ ] 5.1 In `hybridSearch` (`src/search/index.ts:192-230`), dispatch the embed
  promise before the synchronous fulltext scan (`:209-211`) and await it afterward
  inside the existing `try`, preserving the degraded-fulltext-only catch semantics
  (`:216-230`) exactly: only the semantic leg's failure sets `signal.degraded`;
  fulltext errors still propagate.
- [ ] 5.2 Tests: an embed rejection that settles before the fulltext scan finishes
  still degrades gracefully with no `unhandledRejection`; degraded metric/warning
  (`search_embedding_degraded`, `embedding_degraded`) still emitted; result
  membership/ordering identical to the serialized implementation.

## 6. Validation

- [ ] 6.1 Audit `README.md` for accuracy: `README.md:3178` (health-probe timeout
  claim) and the `request_timeout_ms`/`retry` config reference (`README.md:265-275`)
  now match OpenAI behavior — update text only if a claim is still wrong; no new
  config knobs are introduced. If (and only if) `README.md` text changes, mirror it
  in `README.de.md`, `README.es.md`, `README.fr.md`, `README.zh-CN.md`.
- [ ] 6.2 Bump `package.json` version (user-visible: OpenAI embedding calls now honor
  documented timeout/retry; hot-path latency changes).
- [ ] 6.3 `npm run lint` passes (tsc + eslint, no `any` casts in the new helper/caches).
- [ ] 6.4 `npm test` passes.
