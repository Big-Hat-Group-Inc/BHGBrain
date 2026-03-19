## 1. Embedding Provider Tests (`src/embedding/index.test.ts`)

- [ ] 1.1 Stub `global.fetch` with `vi.stubGlobal` to return a successful embeddings response; assert `OpenAIEmbeddingProvider.embed` returns the correct vector
- [ ] 1.2 Assert `embedBatch` preserves sort order when the API returns items out of index order
- [ ] 1.3 Stub `fetch` to throw a network error; assert `embed` throws an `embeddingUnavailable` BrainError
- [ ] 1.4 Stub `fetch` to return HTTP 429; assert `embed` throws an `embeddingUnavailable` BrainError with the status code in the message
- [ ] 1.5 Assert `OpenAIEmbeddingProvider.healthCheck` returns `true` when `embed` succeeds and `false` when it throws
- [ ] 1.6 Assert `DegradedEmbeddingProvider.embed` throws `embeddingUnavailable`
- [ ] 1.7 Assert `DegradedEmbeddingProvider.embedBatch` throws `embeddingUnavailable`
- [ ] 1.8 Assert `DegradedEmbeddingProvider.healthCheck` returns `false`
- [ ] 1.9 Assert `createEmbeddingProvider` returns a `DegradedEmbeddingProvider` when the API key env var is absent
- [ ] 1.10 Assert `createEmbeddingProvider` throws on unknown `config.embedding.provider` values

## 2. HTTP Transport Tests (`src/transport/http.test.ts`)

- [ ] 2.1 Create a minimal `BrainConfig` fixture and stub `ToolContext` / `ResourceHandler` / `HealthService`
- [ ] 2.2 Assert `GET /health` returns 200 with a health body when no auth token is provided (unauthenticated)
- [ ] 2.3 Assert `GET /health` returns 503 when the health stub reports `status: 'unhealthy'`
- [ ] 2.4 Assert `POST /tool/:name` returns 401 when `Authorization` header is absent (auth is configured)
- [ ] 2.5 Assert `POST /tool/:name` returns 401 when an invalid bearer token is provided
- [ ] 2.6 Assert `POST /tool/:name` with a valid bearer token calls `handleTool` and returns its result
- [ ] 2.7 Assert `GET /resource?uri=<uri>` returns 400 when `uri` query param is absent
- [ ] 2.8 Assert `GET /resource?uri=<uri>` with valid token calls `resources.handle` and returns its result
- [ ] 2.9 Assert `GET /metrics` returns 404 (or is unregistered) when `observability.metrics_enabled` is false
- [ ] 2.10 Assert `GET /metrics` returns a plain-text metrics body when `observability.metrics_enabled` is true

## 3. MetricsCollector Tests (`src/health/metrics.test.ts`)

- [ ] 3.1 Assert `incCounter` accumulates correctly across multiple calls
- [ ] 3.2 Assert `incCounter` with custom `amount` adds the correct increment
- [ ] 3.3 Assert `recordHistogram` stores values and `getMetrics` returns correct `_avg` and `_count`
- [ ] 3.4 Assert `BoundedBuffer` wraps correctly at capacity: after `capacity + N` pushes, `values()` returns exactly `capacity` items and `_avg` reflects the most recent window
- [ ] 3.5 Assert `setGauge` overwrites previous value; `getMetrics` returns the latest value
- [ ] 3.6 Assert a disabled `MetricsCollector` (`metrics_enabled: false`) silently ignores all record calls and returns `[]` from `getMetrics`
- [ ] 3.7 Assert `getMetrics` returns entries with correct `name`, `type`, and `value` shape

## 4. Logger / Redaction Tests (`src/health/logger.test.ts`)

- [ ] 4.1 Assert `redactContent` returns the full string when `content.length <= 50`
- [ ] 4.2 Assert `redactContent` returns a string truncated to 50 chars + `...[redacted]` when content exceeds 50 chars
- [ ] 4.3 Assert `redactToken` returns `***` when token length is <= 8
- [ ] 4.4 Assert `redactToken` returns `first4...last4` format when token length > 8
- [ ] 4.5 Assert `createLogger` returns a pino logger with the `level` set from config
- [ ] 4.6 Assert `createLogger` passes `redact` paths to pino when `config.security.log_redaction` is true
- [ ] 4.7 Assert `createLogger` passes `undefined` for `redact` when `config.security.log_redaction` is false

## 5. Health Service Expansion (`src/health/index.test.ts`)

- [ ] 5.1 Assert health check returns `status: 'degraded'` when embedding provider is in degraded mode but SQLite and Qdrant are healthy
- [ ] 5.2 Assert health check returns `status: 'degraded'` when Qdrant is unavailable but SQLite is healthy
- [ ] 5.3 Assert health check returns `status: 'unhealthy'` when SQLite is unavailable
- [ ] 5.4 Assert health check result is cached for 30 seconds (second call within window does not re-invoke sub-checks)

## 6. CLI Smoke Test (`src/cli/index.test.ts`)

- [ ] 6.1 Spy on `process.exit`; import CLI entry with missing required config and assert it exits with code 1
- [ ] 6.2 Assert CLI logs a human-readable error message before exiting on config validation failure
- [ ] 6.3 (Optional) Assert `--transport stdio` and `--transport http` flags route to the correct transport initializer

## 7. CI and Commit

- [ ] 7.1 Run `npm test` and confirm all new tests pass
- [ ] 7.2 Run coverage report and confirm all six target modules have meaningful coverage (>80% line)
- [ ] 7.3 Commit with message: `test: add coverage for embedding, http transport, metrics, logger, health, and cli (codereview2)`
- [ ] 7.4 Push to active branch
