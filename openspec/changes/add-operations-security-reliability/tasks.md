## 1. Transport and Security Controls

- [x] 1.1 Implement HTTP auth middleware enforcing bearer token validation on all HTTP tool/resource routes.
- [x] 1.2 Implement loopback-default host enforcement with explicit config guard for non-loopback binding.
- [x] 1.3 Implement request rate limiting and max payload size enforcement with configurable defaults.
- [x] 1.4 Add integration tests for auth failures, rate-limited responses, and oversized payload rejection.

## 2. Observability and Health

- [x] 2.1 Implement health service that aggregates overall status plus sqlite/qdrant/embedding component states.
- [x] 2.2 Implement structured JSON logging with required fields and default redaction rules.
- [x] 2.3 Implement optional metrics emission gated by configuration.
- [x] 2.4 Add tests for healthy, degraded, and unhealthy status transitions.

## 3. Backup, Audit, and Retention

- [x] 3.1 Implement backup create/list/restore flows including sqlite dump and qdrant snapshot packaging.
- [x] 3.2 Implement restore integrity validation using count and checksum checks before success response.
- [x] 3.3 Implement audit logging for write/delete operations with required metadata fields.
- [ ] 3.4 Implement retention and consolidation jobs for stale detection, cluster surfacing, and contradiction candidates. (audit 2026-06-05: not implemented — `src/backup/retention.ts:88` only marks stale + counts low-importance; no cluster or contradiction detection)
- [x] 3.5 Add outage behavior tests for embedding unavailability, Qdrant fallback, and SQLite lock retry behavior. (audit 2026-06-05: embedding/Qdrant fallback tested; SQLite-lock retry untested because feature is absent — see 4.2)

## 4. Audit follow-ups (2026-06-05)

- [ ] 4.1 Resolve consolidation cluster + contradiction detection (audit finding #1, `src/backup/retention.ts:88`): EITHER implement (a) stale-cluster detection grouping 3+ stale memories by vector similarity above a configurable threshold and (b) a contradiction pass over `audit_log` FORGET/UPDATE events returning structured candidates; OR explicitly de-scope the feature in `proposal.md` and the `retention-and-degradation` spec.
- [ ] 4.2 Resolve SQLite-lock retry/backoff (audit finding #2, `src/storage/sqlite.ts`): EITHER add a generic `withRetry` wrapper around write transactions keyed on busy/locked errors that retries with exponential backoff before returning `INTERNAL`, plus a fault-injection test; OR amend the `retention-and-degradation` spec to document that sql.js is in-process (no OS-level lock) and the retry scenario is a no-op by design.
- [ ] 4.3 Enforce content-preview redaction (audit finding #4, `src/health/logger.ts:4`): add `content`, `preview`, `summary`, `*.content` to the Pino `redact` paths (or route all content fields through `redactContent` at log sites) so redaction is enforced rather than passing by omission; add a test asserting content previews are redacted under `log_redaction`.
- [ ] 4.4 SECURITY — derive audit/client identity from the authenticated principal (audit finding #3, `src/transport/http.ts:42`): stop sourcing the audit `clientId` from the spoofable `x-client-id` header; derive it from `req.ip` and/or the authenticated bearer-token identity, keeping `x-client-id` only as a non-authoritative hint as the rate limiter already does. Add a test that the recorded audit client id is not attacker-controllable.
- [ ] 4.5 Include `namespace` in the `tool_call` audit/request log (audit finding #6, `src/tools/index.ts:59`): thread the resolved namespace into both success and error log branches so logs can be filtered by the primary isolation boundary.
- [ ] 4.6 Resolve dual-store backup fidelity (audit findings #9 + backup row, `src/backup/index.ts`): the current archive packages the SQLite dump only and re-reconciles vectors from SQLite on restore rather than snapshotting them, and restore validates checksum but not memory count. EITHER capture true vector snapshotting + a post-restore `activeCount === header.memory_count` cross-check as implementation tasks, OR cross-reference the existing dual-store backup proposal(s) and de-scope here. At minimum add the memory-count cross-check (audit finding #9).
