# Code Audit — OpenSpec proposal `add-operations-security-reliability`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `add-operations-security-reliability`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 18

## Executive summary

The proposal's transport-security, health, backup, and degradation surfaces are largely implemented and well-tested. Bearer auth, loopback enforcement, fail-closed external-bind checks, rate limiting, request-size limits, a component-level health model, structured Pino logging with redaction, gated metrics, backup create/list/restore with checksum integrity, audit logging, and embedding/Qdrant degradation all exist in first-party `src/`.

However, several spec requirements are only partially met or have drifted:

1. **Consolidation does not detect merge clusters or contradiction candidates** (`retention-and-degradation` spec). `RetentionService.runConsolidation` only marks stale memories and counts low-importance ones; the "3+ similar stale memories" cluster scenario and the "historical delete/correction → contradiction candidates" scenario have no implementation. This is the clearest spec drift.

2. **SQLite-lock retry with exponential backoff is absent.** The spec requires retry-with-backoff before returning `INTERNAL` on a SQLite lock; sql.js is in-process (no real lock), and no retry wrapper exists, so the scenario is structurally unimplementable as written and untested.

3. **Content-preview redaction is asserted by the spec but not enforced by the logger.** The Pino `redact` path list covers tokens/bearer/api_key but not memory content previews; redaction of content depends on callers manually invoking `redactContent`, and the request-logging path logs no content at all (so it passes by omission, not by enforcement).

4. **Audit/rate-limit identity for HTTP is derived from the spoofable `x-client-id` header** for audit records, while rate limiting correctly uses `req.ip`. This is a minor integrity gap in audit metadata.

No critical security defects were found. The highest-severity items are Medium. Spec compliance is **mostly Done with two Partial and one Drifted requirement**.

## Spec compliance

| Requirement / Task | Status | Evidence |
| --- | --- | --- |
| HTTP defaults to loopback bind | Done | `src/transport/middleware.ts:128` `validateLoopbackBinding`; host default `127.0.0.1` enforced |
| Non-loopback bind requires explicit opt-in | Done | `src/transport/middleware.ts:132` throws unless `require_loopback_http=false`; fail-closed auth at `:141` |
| HTTP requires bearer auth; missing/invalid → `AUTH_REQUIRED` | Done | `src/transport/middleware.ts:26-40` |
| Rate + payload limits (`RATE_LIMITED`, `INVALID_INPUT`) | Done | `src/transport/middleware.ts:89-99`, `:114-122`; `src/transport/http.ts:26` |
| Task 1.4 auth/rate/oversize integration tests | Done | `src/transport/middleware.test.ts`, `src/transport/http.test.ts` |
| Health reports overall + sqlite/qdrant/embedding | Done | `src/health/index.ts:22-57` |
| Partial outage → `degraded` with embedding unavailable | Done | `src/health/index.ts:81-103`, `:142-165` |
| Structured logs include required fields | Partial | `src/tools/index.ts:59` lacks `namespace`; success log omits `error_code` (expected); fields otherwise present |
| Sensitive values redacted (tokens + content previews) | Partial | `src/health/logger.ts:4-9` redacts tokens only; content-preview redaction not enforced in `redact` paths |
| Metrics gated by config | Done | `src/health/metrics.ts:55-78`; `src/transport/http.ts:59-66` |
| Task 2.4 health transition tests | Done | `src/health/index.test.ts` |
| Backup create/list/restore w/ metadata + vector snapshot | Partial | `src/backup/index.ts:23-74` packages SQLite dump only; vectors are re-reconciled from SQLite on restore (`:163-206`), not snapshotted in the archive |
| Restore integrity via count + checksum | Partial | `src/backup/index.ts:96-100` validates checksum; memory-count cross-check vs header not asserted before success |
| Audit logging for write/delete with required metadata | Done | `src/storage/index.ts:260-279`; `src/pipeline/index.ts:177,220,306`; `src/tools/index.ts:140,213` |
| Retention marks stale, no age-based hard delete | Done | `src/backup/retention.ts:76-86`; T0 excluded `:33` |
| Consolidation detects clusters + contradictions | Drifted/Missing | `src/backup/retention.ts:88-92` only marks stale + counts low-importance; no cluster (3+ similar) or contradiction detection |
| Failure → degraded: embedding blocks writes, reads continue | Done | `src/embedding/index.ts:106-127` (`DegradedEmbeddingProvider`); search falls back `src/search/index.ts:119-127` |
| Qdrant outage → fulltext fallback | Done | `src/search/index.ts:119-127` |
| SQLite lock retries w/ backoff before `INTERNAL` | Missing | No retry/backoff wrapper in `src/storage/sqlite.ts` or `index.ts` |
| Task 3.5 outage behavior tests | Partial | embedding/search fallback tested; SQLite-lock retry untested (unimplemented) |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Medium | High | M | Maintainability | `src/backup/retention.ts:88` | Consolidation lacks cluster/contradiction detection required by spec |
| 2 | Medium | High | M | Stability | `src/storage/sqlite.ts` | No SQLite-lock retry/backoff path required by spec |
| 3 | Medium | High | S | Security | `src/transport/http.ts:42` | Audit `clientId` taken from spoofable `x-client-id` header |
| 4 | Low | High | S | Logging | `src/health/logger.ts:4` | Content-preview redaction not enforced via Pino redact paths |
| 5 | Low | High | S | Security | `src/transport/middleware.ts:115` | Size limit trusts `Content-Length`; chunked/absent header bypasses pre-check |
| 6 | Low | Medium | S | Logging | `src/tools/index.ts:59` | `tool_call` log omits `namespace` field named in spec |
| 7 | Low | High | S | Stability | `src/transport/middleware.ts:19` | Auth silently skipped when token env unset (loopback dev) |
| 8 | Low | Medium | S | Performance | `src/transport/middleware.ts:48` | Rate-limit buckets are process-global; multi-instance/test bleed |
| 9 | Low | Medium | S | Stability | `src/backup/index.ts:96` | Restore validates checksum but not memory-count vs header |

## Quick wins

- Add `namespace` to the `tool_call` log line (finding #6) — one-field change in `src/tools/index.ts:59`.
- Use `req.ip` (already trusted for rate limiting) instead of `x-client-id` for the HTTP audit `clientId` (finding #3), `src/transport/http.ts:42`.
- Cross-check restored `memoryCount` against `header.memory_count` before returning success (finding #9), `src/backup/index.ts:119`.

## Performance

### [Low · Medium · S] Process-global rate-limit state — `src/transport/middleware.ts:48`
**Issue:** `clientBuckets` and `lastRateLimitSweepAt` are module-level singletons shared across every server instance in the process, with a manual sweep on a 30s cadence rather than per-bucket expiry.
**Why it matters:** Multiple servers in one process (and tests) share limiter state — `resetRateLimitStateForTests` exists precisely because of this. Under sustained many-client load, untouched buckets persist up to a full sweep interval, modestly inflating memory.
**Recommendation:** Encapsulate bucket state in the middleware factory closure so each `createRateLimitMiddleware` call owns its map; keep the lazy sweep.

## Logging & observability

### [Low · High · S] Content-preview redaction not enforced in logger config — `src/health/logger.ts:4`
**Issue:** The Pino `redact` paths are `req.headers.authorization`, `token`, `bearer`, `api_key`. Memory content previews are not in this list; `redactContent` is a standalone helper callers must remember to invoke. The spec scenario "content previews are redacted" passes only because the request-logging path logs no content at all.
**Why it matters:** Any future log statement that includes a `content`/`preview`/`summary` field will leak verbatim payloads despite `log_redaction=true`. Redaction-by-omission is fragile.
**Recommendation:** Add `content`, `preview`, `*.content` to `REDACT_PATHS`, or route all content fields through `redactContent` at log sites and assert in a test.

### [Low · Medium · S] `tool_call` log omits `namespace` — `src/tools/index.ts:59`
**Issue:** The success log emits `event`, `tool`, `duration_ms`, `client_id`, but not `namespace`, which the observability spec lists among required structured fields. `namespace` is available from the parsed args.
**Why it matters:** Operators cannot filter/aggregate request logs by namespace, the system's primary isolation boundary, weakening multi-tenant observability.
**Recommendation:** Thread the resolved namespace into the log line for both success and error branches.

## Stability & reliability

### [Medium · High · M] No SQLite-lock retry with exponential backoff — `src/storage/sqlite.ts`
**Issue:** The retention/degradation spec requires that a SQLite lock triggers retry-with-exponential-backoff before returning `INTERNAL` on exhaustion. No retry wrapper exists in `sqlite.ts` or `storage/index.ts`. The store is sql.js (in-process, single-threaded), so there is no OS-level lock to retry; the scenario is structurally inapplicable yet still asserted by the spec.
**Why it matters:** The spec scenario is neither implemented nor tested, so a future move to a real file-locking driver (better-sqlite3/WAL) would silently violate the contract, and the proposal claims coverage it lacks.
**Recommendation:** Either (a) implement a generic `withRetry` wrapper around write transactions keyed on busy/locked errors and add a fault-injection test, or (b) amend the spec to acknowledge that sql.js's in-process model makes lock-retry a no-op, and document the rationale.

### [Low · Medium · S] Restore validates checksum but not memory-count — `src/backup/index.ts:96`
**Issue:** `restore` recomputes and compares the SHA-256 of the DB body against `header.checksum`, but never compares the post-activation `activeCount` against `header.memory_count`. The spec's restore-integrity requirement names both count and checksum.
**Why it matters:** A backup whose header `memory_count` disagrees with the actual DB (e.g., written by a buggy/older `create`) would still report a successful restore, masking corruption the count check is meant to catch.
**Recommendation:** After `reloadSqliteFromDisk`, assert `activeCount === header.memory_count` and fail with `INVALID_INPUT` on mismatch.

### [Low · High · S] Auth silently skipped when token env unset — `src/transport/middleware.ts:19`
**Issue:** When `process.env[bearer_token_env]` is empty, the auth middleware logs `auth_skip` and calls `next()` — all requests pass. On loopback this is intended dev convenience, and external binds are separately guarded by `validateExternalAuthBinding`.
**Why it matters:** The guard at `:141` only fires for non-loopback hosts. A misconfiguration that binds loopback but is exposed via a reverse proxy / port-forward would serve unauthenticated traffic. The behavior is correct-by-design but easy to misuse.
**Recommendation:** Keep the dev fallback but emit a single startup-level warning (not just per-request) and document the proxy caveat in README security notes.

## Security

### [Medium · High · S] HTTP audit clientId from spoofable header — `src/transport/http.ts:42`
**Issue:** `const clientId = req.headers['x-client-id'] as string ?? 'http-client'` feeds `handleTool`, which records it in audit entries (`logAudit(..., clientId)`). Any client can set an arbitrary `x-client-id`. Rate limiting correctly avoids this by keying on `req.ip` (`middleware.ts:77`), but audit metadata does not.
**Why it matters:** Audit logs are the system's accountability record (spec: "client id" is required audit metadata). A spoofable client id lets a caller impersonate or obscure identity in the audit trail.
**Recommendation:** Derive the audit client id from `req.ip` (optionally combined with an authenticated token identity), keeping `x-client-id` only as a non-authoritative hint as the rate limiter already does.

### [Low · High · S] Size limit trusts Content-Length — `src/transport/middleware.ts:115`
**Issue:** `createSizeLimitMiddleware` rejects based on the `Content-Length` header. A request with no/incorrect `Content-Length` (e.g. chunked transfer) defaults to `0` and bypasses this pre-check.
**Why it matters:** Defense-in-depth gap. It is mitigated because `express.json({ limit })` in `http.ts:26` enforces the real byte limit during parsing, so oversized JSON is still rejected — but the custom middleware gives false assurance and returns a different code than express's parser error.
**Recommendation:** Treat the middleware as a fast-path hint and rely on `express.json` limit as the authoritative enforcement; ensure the express limit-exceeded error is normalized to `INVALID_INPUT` for spec conformance.

## Maintainability & code quality

### [Medium · High · M] Consolidation lacks cluster and contradiction detection — `src/backup/retention.ts:88`
**Issue:** `runConsolidation()` returns `{ staleMarked, lowImportanceCandidates }` where `lowImportanceCandidates` is just `getStaleMemories(0.5, 100).length`. The spec requires (a) surfacing clusters of 3+ stale memories exceeding similarity thresholds as consolidation candidates, and (b) deriving contradiction candidates from historical delete/correction events. Neither exists; there is no similarity comparison and no scan of audit/delete history.
**Why it matters:** Two named spec scenarios are unimplemented, and `tasks.md` item 3.4 is marked `[x]` despite the gap — the proposal overstates completion. Downstream "manual review" controls described in the design have nothing to surface.
**Recommendation:** Implement cluster detection (group stale memories by vector similarity, threshold from config, min size 3) and a contradiction pass over `audit_log` FORGET/UPDATE events; return structured candidates. Update `tasks.md` to reflect actual status until done.

## Testing & coverage

The proposal's testable surfaces are generally well covered: `src/transport/middleware.test.ts` (auth/rate/size/loopback), `src/transport/http.test.ts`, `src/health/index.test.ts` (status transitions), `src/health/logger.test.ts`, `src/health/metrics.test.ts`, `src/backup/index.test.ts` (round-trip + checksum), and `src/backup/retention.test.ts`.

Gaps:
- No tests for consolidation cluster/contradiction detection (feature absent — finding #1).
- No SQLite-lock retry/backoff test (feature absent — finding #2); the spec's degradation scenario for locks is uncovered.
- No assertion that content previews are redacted under `log_redaction` (finding #4) — redaction is by omission.
- No test that the HTTP audit client id is non-spoofable (finding #3).

## Dependencies & supply chain

No issues found. The proposal's implementation uses already-present, appropriate dependencies (`express`, `pino`, `node:crypto`, `uuid`, sql.js, Qdrant client). No new or unusual packages were introduced by these modules, and secrets are sourced via `*_api_key_env` / `bearer_token_env` indirection per project convention.

## Recommendations (prioritized)

1. **(Medium) Implement consolidation cluster + contradiction detection** (`src/backup/retention.ts:88`) or correct `tasks.md` 3.4 status. Closes the only clear spec drift.
2. **(Medium) Fix HTTP audit client-id spoofing** (`src/transport/http.ts:42`) — derive from `req.ip`/auth identity.
3. **(Medium) Resolve the SQLite-lock-retry contract** (`src/storage/sqlite.ts`): implement a `withRetry` wrapper + fault-injection test, or amend the spec to reflect sql.js's in-process model.
4. **(Low) Enforce content-preview redaction** via Pino `redact` paths and add a test (`src/health/logger.ts:4`).
5. **(Low) Add memory-count cross-check on restore** (`src/backup/index.ts:119`).
6. **(Low) Add `namespace` to request logs** (`src/tools/index.ts:59`).
7. **(Low) Normalize express.json limit errors to `INVALID_INPUT`** and treat Content-Length pre-check as a hint (`src/transport/middleware.ts:115`).
8. **(Low) Encapsulate rate-limit bucket state** in the middleware closure (`src/transport/middleware.ts:48`).
9. **(Low) Emit a startup-level warning when auth is skipped** and document the proxy caveat (`src/transport/middleware.ts:19`).
