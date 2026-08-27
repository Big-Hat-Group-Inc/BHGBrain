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
- [x] 2.3 Assert `GET /health` returns 503 when the health stub reports `status: 'unhealthy'` (audit 2026-06-05: partial — `unhealthy`→503 covered; `degraded`→200 path at `http.ts:31` untested)
- [x] 2.4 Assert `POST /tool/:name` returns 401 when `Authorization` header is absent (auth is configured)
- [x] 2.5 Assert `POST /tool/:name` returns 401 when an invalid bearer token is provided
- [x] 2.6 Assert `POST /tool/:name` with a valid bearer token calls `handleTool` and returns its result
- [x] 2.7 Assert `GET /resource?uri=<uri>` returns 400 when `uri` query param is absent
- [x] 2.8 Assert `GET /resource?uri=<uri>` with valid token calls `resources.handle` and returns its result
- [x] 2.9 Assert `GET /metrics` returns 404 (or is unregistered) when `observability.metrics_enabled` is false
- [x] 2.10 Assert `GET /metrics` returns a plain-text metrics body when `observability.metrics_enabled` is true

## 3. MetricsCollector Tests (`src/health/metrics.test.ts`)

- [x] 3.1 Assert `incCounter` accumulates correctly across multiple calls (audit 2026-06-05: not implemented — `incCounter` never called in `src/health/metrics.test.ts`; `metrics.ts:85-86` uncovered)
- [x] 3.2 Assert `incCounter` with custom `amount` adds the correct increment (audit 2026-06-05: not implemented)
- [x] 3.3 Assert `recordHistogram` stores values and `getMetrics` returns correct `_avg` and `_count`
- [x] 3.4 Assert `BoundedBuffer` wraps correctly at capacity: after `capacity + N` pushes, `values()` returns exactly `capacity` items and `_avg` reflects the most recent window (audit 2026-06-05: partial — wrap verified indirectly via percentile count cap; `values()`/`_avg` window not asserted directly)
- [x] 3.5 Assert `setGauge` overwrites previous value; `getMetrics` returns the latest value (audit 2026-06-05: not implemented — `setGauge` never called; `metrics.ts:100-101` uncovered)
- [x] 3.6 Assert a disabled `MetricsCollector` (`metrics_enabled: false`) silently ignores all record calls and returns `[]` from `getMetrics` (audit 2026-06-05: not implemented — disabled-collector path/`metrics.ts:107-108` uncovered)
- [x] 3.7 Assert `getMetrics` returns entries with correct `name`, `type`, and `value` shape (audit 2026-06-05: partial — `name`/`value` asserted; `type` field never asserted)

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
- [x] 5.4 Assert health check result is cached for 30 seconds (second call within window does not re-invoke sub-checks) (audit 2026-06-05: partial — within-window caching proven by call count; 30s TTL boundary not time-asserted, no fake-timer advance past expiry)

## 6. CLI Smoke Test (`src/cli/index.test.ts`)

- [x] 6.1 Spy on `process.exit`; import CLI entry with missing required config and assert it exits with code 1
- [x] 6.2 Assert CLI logs a human-readable error message before exiting on config validation failure
- [x] 6.3 Assert CLI `server start --stdio` delegates to the stdio server initializer path

## 7. CI and Commit

- [x] 7.1 Run `npm test` and confirm all new tests pass
- [x] 7.2 Run coverage report and confirm all six target modules have meaningful coverage (>80% line)
- [x] 7.3 Commit with message: `test: add coverage for embedding, http transport, metrics, logger, health, and cli (codereview2)`
- [x] 7.4 Push to active branch

## Audit follow-ups (2026-06-05)

Source: `codeaudit/expand-test-coverage-2026-06-05-02-19.md`. These items close the gaps
and design deviations the audit found. No production code under `src/` changes — test
files only.

- [x] 8.1 Implement task 3.1 — `incCounter('c'); incCounter('c')` then assert `getMetrics()` contains `{ name: 'c', type: 'counter', value: 2 }` (covers `metrics.ts:85-86`)
- [x] 8.2 Implement task 3.2 — `incCounter('c', 3)` adds the custom amount; assert accumulated value reflects the increment
- [x] 8.3 Implement task 3.5 — `setGauge('g', 1); setGauge('g', 2)` then assert `getMetrics()` reports the latest value `2` (covers `metrics.ts:100-101`)
- [x] 8.4 Implement task 3.6 — construct `new MetricsCollector(createConfig(false))`, issue record/counter/gauge calls, then assert `getMetrics()` deep-equals `[]` (covers the disabled branch / `metrics.ts:107-108`)
- [x] 8.5 Finish Partial 3.4 — assert `BoundedBuffer` wrap directly: after `capacity + N` pushes, `values()` returns exactly `capacity` items and `_avg` reflects the most-recent window (not only via percentile count cap)
- [x] 8.6 Finish Partial 3.7 — assert the `type` field on `getMetrics()` entries (e.g. `_count`→`'counter'`, `_avg`/`_p95`→`'histogram'`, gauge→`'gauge'`)
- [x] 8.7 Finish Partial 5.4 — add a `vi.useFakeTimers()` variant that advances past the 30s cache window and asserts sub-checks (`embedding.healthCheck`) are re-invoked after expiry, confirming both cache hit and TTL boundary
- [x] 8.8 Finish Partial 2.3 — assert `GET /health` returns 200 when the health stub reports `status: 'degraded'` (covers `http.ts:31`)
- [x] 8.9 FIX HTTP suite drift from design — rewrite `src/transport/http.test.ts` to drive the Express app in-process via `supertest(app)` with no real socket bind; remove `app.listen(0)` + `fetch`, the `closeIdleConnections`/`closeAllConnections`/`close` teardown plumbing, and the bumped 15s timeout, per design Decision "Use `supertest` ... never call `.listen()` in tests". (If real-port binding is instead chosen deliberately, the design must be amended to record that decision rather than leaving code and design contradictory.)
- [x] 8.10 Re-run `npm test` and coverage; confirm `metrics.ts` branch coverage rises (counter/gauge/disabled branches covered) and all suites stay green
