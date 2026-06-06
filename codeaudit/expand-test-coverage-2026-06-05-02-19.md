# Code Audit — OpenSpec proposal `expand-test-coverage`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `expand-test-coverage`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Vitest, Zod config, Pino, sql.js+Qdrant
- **Files reviewed:** 12 (4 proposal artifacts, 6 test files, 5 source-under-test modules; `src/health/index.ts` counts in both)

## Executive summary

The proposal is a test-only change adding coverage for six previously-untested or thinly-tested modules. Implementation is largely complete and high quality: all 37 targeted tests pass, and every one of the six named target modules clears the >80% line-coverage gate stated in task 7.2 (http.ts 100%, embedding/index.ts 98.4%, logger.ts 93.9%, cli/index.ts 92.1%, health/index.ts 91.9%, metrics.ts 82.1%). Tests use real assertions, deterministic `fetch`/module mocking, proper teardown (`vi.unstubAllGlobals`, `vi.resetModules`, env cleanup, server close), and exercise error and degraded paths. The commit (`a8cee42`) matches the task 7.3 message verbatim.

Two areas drift from the spec. First, `src/health/metrics.test.ts` does **not** assert the counter (3.1, 3.2), gauge-overwrite (3.5), disabled-collector-returns-`[]` (3.6), or explicit metric-shape `type` (3.7) behaviors the tasks enumerate — it only tests histograms/percentiles, leaving `incCounter`, `setGauge`, and the disabled-path branches uncovered (metrics.ts lines 85-86, 100-101, 107-108). Second, `src/transport/http.test.ts` binds a real socket with `app.listen(0)` and drives it over the network with `fetch`, directly contradicting the design's explicit decision to use supertest/in-process mode and its stated mitigation "never call `.listen()` in tests." The tests pass today but carry the port-binding and connection-teardown flakiness the design intended to avoid. No production code was modified. No high-severity defects found.

## Spec compliance

| Requirement / Task | Status | Evidence |
|---|---|---|
| 1.1 OpenAI embed success returns vector | Done | `src/embedding/index.test.ts:100-113` stubs fetch, asserts `[0.1,0.2,0.3]` |
| 1.2 embedBatch preserves index order | Done | `src/embedding/index.test.ts:115-126` out-of-order data → sorted result |
| 1.3 network failure → embeddingUnavailable | Done | `src/embedding/index.test.ts:128-136` |
| 1.4 HTTP 429 → error with status code | Done | `src/embedding/index.test.ts:138-144` asserts `'Embedding API error 429'` |
| 1.5 healthCheck true on success / false on throw | Done | `src/embedding/index.test.ts:146-167` (split across two tests) |
| 1.6 DegradedEmbeddingProvider.embed throws | Done | `src/embedding/index.test.ts:173` |
| 1.7 DegradedEmbeddingProvider.embedBatch throws | Done | `src/embedding/index.test.ts:174` |
| 1.8 DegradedEmbeddingProvider.healthCheck false | Done | `src/embedding/index.test.ts:175` |
| 1.9 createEmbeddingProvider degraded on missing key | Done | `src/embedding/index.test.ts:177-178`, also Azure `187-190` |
| 1.10 throws on unknown provider | Done | `src/embedding/index.test.ts:205-215` |
| 2.1 BrainConfig fixture + stubbed ctx/resources | Done | `src/transport/http.test.ts:12-116` |
| 2.2 GET /health 200 unauthenticated | Done | `src/transport/http.test.ts:131-138` (no auth header sent) |
| 2.3 GET /health 503 when unhealthy | Partial | `src/transport/http.test.ts:140-146` covers `unhealthy`→503; `degraded`→200 path (http.ts:31) untested |
| 2.4 POST /tool 401 missing auth | Done | `src/transport/http.test.ts:152-157` |
| 2.5 POST /tool 401 invalid token | Done | `src/transport/http.test.ts:159-167` |
| 2.6 valid token calls handleTool | Done | `src/transport/http.test.ts:179-190` asserts args incl. client id |
| 2.7 GET /resource 400 missing uri | Done | `src/transport/http.test.ts:192-195` |
| 2.8 GET /resource valid → resources.handle | Done | `src/transport/http.test.ts:197-202` |
| 2.9 GET /metrics 404 when disabled | Done | `src/transport/http.test.ts:208-214` |
| 2.10 GET /metrics text body when enabled | Done | `src/transport/http.test.ts:216-229` |
| 3.1 incCounter accumulates | Missing | No `incCounter` call anywhere in `src/health/metrics.test.ts` |
| 3.2 incCounter custom amount | Missing | Not present |
| 3.3 recordHistogram avg/count | Done | `src/health/metrics.test.ts:65-79` (`_avg`=25, `_count`=4) |
| 3.4 BoundedBuffer wrap at capacity | Partial | `src/health/metrics.test.ts:91-102` verifies count caps at 1000 after 1005 pushes via percentiles; never calls `BoundedBuffer.values()`/`_avg` window directly as worded |
| 3.5 setGauge overwrite | Missing | No `setGauge` call in test |
| 3.6 disabled collector returns `[]` | Missing | No disabled-collector test; `createConfig(false)` path unused |
| 3.7 getMetrics shape (name/type/value) | Partial | `name`/`value` asserted via `Object.fromEntries`; `type` field never asserted |
| 4.1 redactContent full when ≤50 | Done | `src/health/logger.test.ts:70` |
| 4.2 redactContent truncated >50 | Done | `src/health/logger.test.ts:71` |
| 4.3 redactToken `***` when ≤8 | Done | `src/health/logger.test.ts:72` |
| 4.4 redactToken first4…last4 | Done | `src/health/logger.test.ts:73` |
| 4.5 createLogger level from config | Done | `src/health/logger.test.ts:76-94` (`level:'warn'`) |
| 4.6 redact paths when redaction on | Done | `src/health/logger.test.ts:87-93` |
| 4.7 redact undefined when off | Done | `src/health/logger.test.ts:96-114` |
| 5.1 degraded when embedding degraded | Done | `src/health/index.test.ts:122-129` |
| 5.2 degraded when Qdrant unavailable | Done | `src/health/index.test.ts:208-217` |
| 5.3 unhealthy when SQLite unavailable | Done | `src/health/index.test.ts:219-228` |
| 5.4 health check cached 30s | Partial | `src/health/index.test.ts:187-197` proves embedding `healthCheck` called once across 3 calls; no time-advance to prove 30s window boundary |
| 6.1 process.exit(1) on bad config | Done | `src/cli/index.test.ts:177-192` |
| 6.2 human-readable error before exit | Done | `src/cli/index.test.ts:190-191` (`'Fatal error:'` + message) |
| 6.3 `server start --stdio` delegates to stdio path | Done | `src/cli/index.test.ts:231,239-243` asserts `execFileSync` w/ `--stdio` |
| 7.1 npm test passes | Done | All 6 targeted files pass (37 tests) |
| 7.2 six modules >80% line coverage | Done | Verified: 82.1%–100% across all six |
| 7.3 commit message | Done | Commit `a8cee42` message matches exactly |
| 7.4 push to active branch | Done (assumed) | Commit present in history; push not independently verifiable here |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
|---|---|---|---|---|---|---|
| 1 | Medium | High | S | Testing | `src/health/metrics.test.ts:65` | Counter, gauge, and disabled-collector tasks (3.1/3.2/3.5/3.6) never asserted; branches uncovered |
| 2 | Low | High | M | Testing | `src/transport/http.test.ts:109` | Uses real `app.listen(0)`+fetch, contradicting design's supertest/no-`.listen()` decision |
| 3 | Low | High | S | Testing | `src/health/metrics.test.ts:72` | Metric `type` field (3.7) never asserted; shape check is partial |
| 4 | Low | Medium | S | Testing | `src/health/index.test.ts:187` | Cache "30 second" boundary (5.4) not time-asserted; only call-count |
| 5 | Low | Low | S | Maintainability | `src/embedding/index.test.ts:8` | ~60-line `createConfig` fixture duplicated verbatim across 4 test files |

## Quick wins

- Add three short assertions to `src/health/metrics.test.ts` covering `incCounter` accumulation/amount, `setGauge` overwrite, and a disabled `MetricsCollector` returning `[]` (Finding 1, 3) — closes four task items and the uncovered branches in one small edit.
- Assert `entry.type` in the existing metrics shape test (Finding 3).
- Extract the repeated `createConfig()` BrainConfig fixture into a shared test helper (Finding 5).

## Performance

No issues found.

## Logging & observability

No issues found. (The logger redaction control — a security concern flagged in the design — is verified at `src/health/logger.test.ts:68-114`, including the on/off `redact` branch.)

## Stability & reliability

No issues found. Tests are deterministic: `fetch` is stubbed, time-dependent paths use injected clocks (`() => 0` for `CircuitBreaker` at `src/health/index.test.ts:137`), and servers are closed in teardown. See Finding 2 for the one networked-test reliability caveat.

## Security

No issues found. Auth enforcement order is verified end-to-end: `/health` answers without a token (`src/transport/http.test.ts:131-138`) while `/tool/:name` returns 401 for both missing and invalid bearer tokens (`:152-167`), matching the middleware registration order in `src/transport/http.ts:29-36`. Log redaction (key-leak control) is covered as noted above.

## Maintainability & code quality

### [Low · Low · S] Duplicated BrainConfig fixture across four test files — `src/embedding/index.test.ts:8`

**Issue:** A near-identical ~60-line `createConfig()` BrainConfig literal is copy-pasted into `src/embedding/index.test.ts:8`, `src/transport/http.test.ts:12`, `src/health/metrics.test.ts:6`, and `src/health/logger.test.ts:5` (with minor field tweaks). `src/health/index.test.ts:10` carries yet another copy.

**Why it matters:** When the Zod `BrainConfig` schema gains a required field, five fixtures must be updated in lockstep; a missed one produces a compile/type error or a silently wrong test. This is the dominant maintenance cost introduced by the change.

**Recommendation:** Extract a shared `makeTestConfig(overrides?)` helper (e.g. `src/config/test-fixtures.ts`, excluded from coverage) and have each test import it. Keeps drift to a single edit.

## Testing & coverage

### [Medium · High · S] Counter, gauge, and disabled-collector behaviors are unasserted — `src/health/metrics.test.ts:65`

**Issue:** Tasks 3.1, 3.2, 3.5, and 3.6 require asserting `incCounter` accumulation, `incCounter` with a custom amount, `setGauge` overwrite, and a disabled collector returning `[]`. The test file never calls `incCounter` or `setGauge`, and never constructs a disabled collector (`createConfig(false)` is defined at line 6 but unused). Coverage confirms the gap: `metrics.ts` lines 85-86 (counter emission), 100-101 (gauge emission), and 107-108 are uncovered, and branch coverage sits at 70.8%. The `BoundedBuffer.values()` enabled/empty branch and gauge map iteration ship without a direct test.

**Why it matters:** `MetricsCollector` is exactly the kind of thin utility the design says was "left untested because [it is a] thin wrapper" — the whole point of the change. Counter/gauge accumulation and the disabled short-circuit are public-API contracts the `/metrics` endpoint and rate-limiter depend on; a regression (e.g. counters not summing, disabled collector emitting data) would now still ship silently for these specific paths.

**Recommendation:** Add assertions: (a) `incCounter('c'); incCounter('c', 3)` → `getMetrics()` contains `{name:'c', type:'counter', value:4}`; (b) `setGauge('g',1); setGauge('g',2)` → latest value `2`; (c) `new MetricsCollector(createConfig(false))` after record calls → `getMetrics()` deep-equals `[]`.

### [Low · High · M] HTTP transport tests bind a real socket, contradicting the design — `src/transport/http.test.ts:109`

**Issue:** `startServer` calls `app.listen(0, '127.0.0.1', ...)` (`:109-111`) and drives the server with real `fetch` to an ephemeral port. The design explicitly decided to "use `supertest(app)` ... without binding to a port ... never call `.listen()` in tests" (`design.md:31-34, 44-45`) as the mitigation for the "must not accidentally start a real server" risk. The implementation does the opposite.

**Why it matters:** Binding real ports reintroduces the connection-teardown and CI port-pressure flakiness the design aimed to eliminate; the suite already needs explicit `closeIdleConnections`/`closeAllConnections`/`close` plumbing (`:118-124`) and a bumped 15s timeout (`:147`) to stay green — symptoms of the heavier approach. Functionally the tests are correct, so severity is low, but it is a documented design deviation.

**Recommendation:** Either switch to `supertest(app)` in-process (no `.listen()`), or update `design.md` to record that real-port binding was chosen and why. Don't leave code and design contradicting each other.

### [Low · High · S] Metric entry `type` field never asserted — `src/health/metrics.test.ts:72`

**Issue:** Task 3.7 asks for assertions on `name`, `type`, and `value`. The shape check at `:72` does `Object.fromEntries(metrics.getMetrics().map(e => [e.name, e.value]))`, discarding `e.type` entirely. The counter-vs-histogram-vs-gauge `type` tagging in `metrics.ts:84-101` is never verified.

**Why it matters:** The `type` field distinguishes counters from histograms/gauges; a regression mislabeling them would pass the current suite. Minor, since the `/metrics` text exporter ignores `type` today.

**Recommendation:** Add one assertion that `getMetrics()` entries carry the expected `type` (e.g. `_count` is `'counter'`, `_avg`/`_p95` are `'histogram'`).

### [Low · Medium · S] Health cache "30 second" window not time-asserted — `src/health/index.test.ts:187`

**Issue:** Task 5.4 asks to verify the result is cached "for 30 seconds (second call within window does not re-invoke sub-checks)." The test (`:187-197`) makes three back-to-back `check()` calls and asserts `embedding.healthCheck` ran once — it proves caching exists but never advances time to confirm the 30s TTL boundary (no re-check after expiry, no `vi.useFakeTimers`).

**Why it matters:** A bug that caches forever (TTL ignored) or never caches across the boundary would not be caught. Low severity — the within-window contract, which is what `/health` hammering relies on, is verified.

**Recommendation:** Add a fake-timer variant that advances past 30s and asserts `healthCheck` is invoked a second time, confirming both the cache and its expiry.

## Dependencies & supply chain

No issues found. The change adds no dependencies; it uses already-present `vitest` primitives (`vi.stubGlobal`, `vi.mock`, `vi.doMock`) and Node built-ins (`node:net`, `node:http`). Notably, `supertest` was discussed in the design but not added — consistent with Finding 2's real-`fetch` approach (no new dep, but a design deviation).

## Recommendations (prioritized)

1. **(Medium)** Close the metrics coverage gap — add counter/gauge/disabled-collector assertions to `src/health/metrics.test.ts` (Finding 1). Smallest edit with the largest spec-compliance payoff: resolves four Missing tasks and the uncovered branches.
2. **(Low)** Reconcile the HTTP test approach with the design — adopt supertest in-process or amend `design.md` to document the real-port decision (Finding 2).
3. **(Low)** Add the `type`-field and degraded-status (`/health`→200) assertions to fully satisfy tasks 3.7 and 2.3 (Findings 3, Spec table row 2.3).
4. **(Low)** Add a fake-timer test for the 30s health-cache expiry (Finding 4).
5. **(Low)** Extract the shared BrainConfig test fixture to eliminate five-way duplication (Finding 5).
