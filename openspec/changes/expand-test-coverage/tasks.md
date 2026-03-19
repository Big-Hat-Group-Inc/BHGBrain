## 1. Embedding Provider Tests (`src/embedding/index.test.ts`)

- [x] 1.1 Stub `global.fetch` with `vi.stubGlobal` to return a successful embeddings response; assert `OpenAIEmbeddingProvider.embed` returns the correct vector
- [x] 1.2 Assert `embedBatch` preserves sort order when the API returns items out of index order
- [x] 1.3 Stub `fetch` to throw a network error; assert `embed` throws an `embeddingUnavailable` BrainError
- [x] 1.4 Stub `fetch` to return HTTP 429; assert `embed` throws an `embeddingUnavailable` BrainError with the status code in the message
- [x] 1.5 Assert `OpenAIEmbeddingProvider.healthCheck` returns `true` when `embed` succeeds and `false` when it throws
- [x] 1.6 Assert `DegradedEmbeddingProvider.embed` throws `embeddingUnavailable`
- [x] 1.7 Assert `DegradedEmbeddingProvider.embedBatch` throws `embeddingUnavailable`
- [x] 1.8 Assert `DegradedEmbeddingProvider.healthCheck` returns `false`
- [x] 1.9 Assert `createEmbeddingProvider` returns a `DegradedEmbeddingProvider` when the API key env var is absent
- [x] 1.10 Assert `createEmbeddingProvider` throws on unknown `config.embedding.provider` values

## 2. HTTP Transport Tests (`src/transport/http.test.ts`)

- [x] 2.1 Create a minimal `BrainConfig` fixture and stub `ToolContext` / `ResourceHandler` / `HealthService`
- [x] 2.2 Assert `GET /health` returns 200 with a health body when no auth token is provided (unauthenticated)
- [x] 2.3 Assert `GET /health` returns 503 when the health stub reports `status: 'unhealthy'`
- [x] 2.4 Assert `POST /tool/:name` returns 401 when `Authorization` header is absent (auth is configured)
- [x] 2.5 Assert `POST /tool/:name` returns 401 when an invalid bearer token is provided
- [x] 2.6 Assert `POST /tool/:name` with a valid bearer token calls `handleTool` and returns its result
- [x] 2.7 Assert `GET /resource?uri=<uri>` returns 400 when `uri` query param is absent
- [x] 2.8 Assert `GET /resource?uri=<uri>` with valid token calls `resources.handle` and returns its result
- [x] 2.9 Assert `GET /metrics` returns 404 (or is unregistered) when `observability.metrics_enabled` is false
- [x] 2.10 Assert `GET /metrics` returns a plain-text metrics body when `observability.metrics_enabled` is true

## 3. MetricsCollector Tests (`src/health/metrics.test.ts`)

- [x] 3.1 Assert `incCounter` accumulates correctly across multiple calls
- [x] 3.2 Assert `incCounter` with custom `amount` adds the correct increment
- [x] 3.3 Assert `recordHistogram` stores values and `getMetrics` returns correct `_avg` and `_count`
- [x] 3.4 Assert `BoundedBuffer` wraps correctly at capacity: after `capacity + N` pushes, `values()` returns exactly `capacity` items and `_avg` reflects the most recent window
- [x] 3.5 Assert `setGauge` overwrites previous value; `getMetrics` returns the latest value
- [x] 3.6 Assert a disabled `MetricsCollector` (`metrics_enabled: false`) silently ignores all record calls and returns `[]` from `getMetrics`
- [x] 3.7 Assert `getMetrics` returns entries with correct `name`, `type`, and `value` shape

## 4. Logger / Redaction Tests (`src/health/logger.test.ts`)

- [x] 4.1 Assert `redactContent` returns the full string when `content.length <= 50`
- [x] 4.2 Assert `redactContent` returns a string truncated to 50 chars + `...[redacted]` when content exceeds 50 chars
- [x] 4.3 Assert `redactToken` returns `***` when token length is <= 8
- [x] 4.4 Assert `redactToken` returns `first4...last4` format when token length > 8
- [x] 4.5 Assert `createLogger` returns a pino logger with the `level` set from config
- [x] 4.6 Assert `createLogger` passes `redact` paths to pino when `config.security.log_redaction` is true
- [x] 4.7 Assert `createLogger` passes `undefined` for `redact` when `config.security.log_redaction` is false

## 5. Health Service Expansion (`src/health/index.test.ts`)

- [x] 5.1 Assert health check returns `status: 'degraded'` when embedding provider is in degraded mode but SQLite and Qdrant are healthy
- [x] 5.2 Assert health check returns `status: 'degraded'` when Qdrant is unavailable but SQLite is healthy
- [x] 5.3 Assert health check returns `status: 'unhealthy'` when SQLite is unavailable
- [x] 5.4 Assert health check result is cached for 30 seconds (second call within window does not re-invoke sub-checks)

## 6. CLI Smoke Test (`src/cli/index.test.ts`)

- [x] 6.1 Spy on `process.exit`; import CLI entry with missing required config and assert it exits with code 1
- [x] 6.2 Assert CLI logs a human-readable error message before exiting on config validation failure
- [x] 6.3 Assert CLI `server start --stdio` delegates to the stdio server initializer path

## 7. CI and Commit

- [x] 7.1 Run `npm test` and confirm all new tests pass
- [x] 7.2 Run coverage report and confirm all six target modules have meaningful coverage (>80% line)
- [ ] 7.3 Commit with message: `test: add coverage for embedding, http transport, metrics, logger, health, and cli (codereview2)`
- [ ] 7.4 Push to active branch
