## Why

The v1 specification includes explicit reliability and security guarantees that are not covered by core memory logic or MCP contracts alone. Production-readiness requires transport hardening, operational observability, backup integrity, and predictable degradation behavior under failures.

## What Changes

- Define transport security defaults for HTTP and stdio modes, including bearer-token requirements and loopback protection.
- Define rate-limiting and request-size enforcement requirements.
- Add health status contracts, structured logging redaction requirements, and optional metrics behavior.
- Define backup create/list/restore requirements and integrity validation expectations.
- Define retention (stale-marking, low-importance detection) and graceful degradation behaviors for embedding, Qdrant, and SQLite failure modes. Consolidation cluster/contradiction detection is explicitly out of scope for this change — see the de-scope note below.
- Define audit-log requirements for write/delete operations and sensitive-operation controls.
- (Audit follow-up 2026-06-05) Require audit/client identity to be derived from the authenticated principal (`req.ip` / bearer-token identity), never from the spoofable `x-client-id` request header.
- (Audit follow-up 2026-06-05, resolved: de-scoped) Consolidation cluster + contradiction detection was marked done but unimplemented. Resolution: **explicitly de-scoped** rather than implemented. `RetentionService.runConsolidation()` continues to report stale-marking and low-importance counts only; grouping stale memories into similarity clusters and mining `audit_log` for contradiction candidates are undefined product behaviors (no similarity-threshold config, no contradiction-candidate shape exists anywhere in the codebase) and building either under audit pressure risked shipping a low-confidence heuristic dressed up as a real feature. The `retention-and-degradation` spec's `Consolidation SHALL detect merge clusters and contradictions` requirement has been removed accordingly; a future change can reintroduce it once cluster/contradiction semantics are actually specified.
- (Audit follow-up 2026-06-05, resolved: de-scoped with rationale) The SQLite-lock retry/backoff behavior was marked done but unimplemented. Resolution: **documented as an intentional no-op**, not implemented. `sql.js` is an in-process, single-threaded WASM SQLite build with one `Database` instance per Node process and no OS-level file lock contended by concurrent writers, so there is no transient "database is locked" condition for a retry-with-backoff wrapper to recover from. See the rationale comment above `SqliteStore` in `src/storage/sqlite.ts` and the `In-process store documents retry as no-op` scenario in the `retention-and-degradation` spec.
- (Audit follow-up 2026-06-05) Require content-preview redaction to be enforced by the logger config (not by omission) and the `namespace` field to be present in request/audit logs.

## Capabilities

### New Capabilities
- `transport-auth-security`: HTTP/stdio transport behavior, bearer auth handling, loopback defaults, and input-size/rate controls.
- `observability-health`: health endpoint semantics, structured logging fields, redaction, and optional metrics behavior.
- `backup-and-audit`: backup lifecycle, restore integrity checks, and audit logging for state-changing operations.
- `retention-and-degradation`: decay/consolidation rules and runtime fallback/degraded behavior during dependency failures.

### Modified Capabilities
- None.

## Impact

- Affects server startup/config modules, middleware stack, and failure handling paths.
- Requires additional persistence structures for audit and backup metadata.
- Adds integration and load-test coverage for outage handling, rate limits, and backup round-trip fidelity.
