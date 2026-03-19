## Context

The existing 13-file test suite covers core storage, domain logic, search, services, and middleware well. The gaps are concentrated in integration boundary modules (embedding API calls, HTTP server wiring) and small utility modules (metrics, logger) that were likely left untested because they are thin wrappers. However:

- **Embedding:** `healthCheck` uses a live `embed` call; this pattern has retry implications. The degraded provider's rejection behavior is a documented contract that other services depend on (e.g., search gracefully degrades when embedding is unavailable).
- **HTTP transport:** `createHttpServer` wires auth, rate limiting, and routing in a specific order. A mis-ordered middleware registration would be invisible without tests.
- **Log redaction:** `redactToken` and `redactContent` are security controls. A regression in either could leak API keys or memory content to logs.
- **MetricsCollector:** The `BoundedBuffer` circular buffer has a non-trivial overflow path; the histogram average calculation depends on correct `length` tracking.

## Goals / Non-Goals

**Goals:**
- Achieve meaningful coverage of each uncovered module's public API and documented failure modes.
- Verify auth enforcement order in the HTTP server (health endpoint must not require auth; all others must).
- Verify log redaction thresholds match documented behavior.
- Verify `BoundedBuffer` wraps correctly and reports correct statistics after wrap.

**Non-Goals:**
- 100% line coverage on every file.
- End-to-end integration tests against live OpenAI or Qdrant services.
- CLI argument parsing exhaustiveness — focus on transport selection and fatal error paths.

## Decisions

### Decision: Mock `fetch` for embedding tests rather than using live API

**Why:** Tests should be deterministic and not require network access. `vitest` supports `vi.spyOn(global, 'fetch')` or `vi.stubGlobal('fetch', ...)` for clean mocking.

**Alternative considered:** Use a local HTTP server (msw or similar). Acceptable but heavier; `fetch` stubbing is sufficient for unit-level tests.

### Decision: Use `supertest` or direct Express app for HTTP transport tests

**Why:** `createHttpServer` returns an Express app. `supertest(app)` allows route and response assertions without binding to a port. Zero network overhead, no port conflicts in CI.

**Alternative considered:** Instantiate a real server on a random port. Adds complexity without value at unit-test level.

### Decision: Expand health index tests with stub sub-components

**Why:** The existing health test is likely a smoke test. Degraded-component scenarios (Qdrant unavailable, embedding degraded) are the exact conditions that trigger `degraded` status — these must be verified explicitly because the HTTP `/health` route exposes this status externally.

## Risks / Trade-offs

- **[Risk] CLI tests are harder to unit-test** — `src/cli/index.ts` likely calls `process.exit()` on errors, which terminates the test runner. Mitigation: spy on `process.exit`, or use a child-process integration test with expected exit code assertions.
- **[Risk] HTTP transport tests must not accidentally start a real server** — Mitigation: use `supertest` in-process mode only; never call `.listen()` in tests.
