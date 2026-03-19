## Why

codereview2.md identifies six modules with no test coverage despite being critical to system correctness and security:

- `src/embedding/index.ts` — OpenAI API integration: retry/error handling, degraded provider fallback, health check behavior
- `src/transport/http.ts` — HTTP server: route correctness, auth enforcement on all guarded endpoints, health endpoint availability without auth
- `src/health/metrics.ts` — MetricsCollector: counter/histogram/gauge accumulation, bounded buffer overflow, `getMetrics` output shape
- `src/health/logger.ts` — `createLogger`, `redactContent`, `redactToken` — log redaction is a security control and must be verified
- `src/cli/index.ts` — CLI entry point: transport selection, config validation errors, clean shutdown
- `src/health/index.ts` — Existing test exists but is noted as likely needing expansion (component isolation, degraded sub-component handling)

Each of these is either on a critical path (auth, embedding, HTTP routing) or is a security control (log redaction). Untested code in these areas means regressions can ship silently.

## What Changes

- Add a `src/embedding/index.test.ts` covering `OpenAIEmbeddingProvider` (success, API error, network failure, batch ordering), `DegradedEmbeddingProvider` (rejects all embed calls, healthCheck returns false), and `createEmbeddingProvider` (degraded fallback on missing credentials).
- Add a `src/transport/http.test.ts` covering all routes: health (unauthenticated), tool POST (authenticated), resource GET (authenticated), metrics GET (conditionally enabled), 401 on missing/invalid token.
- Add a `src/health/metrics.test.ts` covering counter increment, histogram bounded buffer behavior (overflow wraps, avg computation), gauge set/overwrite, disabled collector returns empty, `getMetrics` output shape.
- Add a `src/health/logger.test.ts` covering `redactContent` truncation boundary, `redactToken` short/long token handling, `createLogger` respects log level config.
- Add a `src/cli/index.test.ts` or integration smoke test covering CLI transport flag routing and config validation error exit codes.
- Expand `src/health/index.test.ts` to cover degraded sub-component scenarios (Qdrant unavailable, embedding degraded, SQLite initialized).

## Capabilities

### New Capabilities
- `embedding-provider-test-coverage`: Embedding provider behavior is verified under success, failure, degraded, and health-check scenarios.
- `http-transport-test-coverage`: HTTP server routes, auth enforcement, and conditional endpoints are verified.
- `metrics-logger-test-coverage`: MetricsCollector and logger utilities (including redaction) are verified.

### Modified Capabilities
- `health-service-test-coverage`: Health index tests expanded to cover degraded sub-components.

## Impact

- New test files: `src/embedding/index.test.ts`, `src/transport/http.test.ts`, `src/health/metrics.test.ts`, `src/health/logger.test.ts`, `src/cli/index.test.ts`
- Modified test file: `src/health/index.test.ts`
- No production code changes. Test infrastructure only.
- Coverage gates (if configured) will reflect the new coverage.
