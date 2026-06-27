## Why

The v1 specification includes explicit reliability and security guarantees that are not covered by core memory logic or MCP contracts alone. Production-readiness requires transport hardening, operational observability, backup integrity, and predictable degradation behavior under failures.

## What Changes

- Define transport security defaults for HTTP and stdio modes, including bearer-token requirements and loopback protection.
- Define rate-limiting and request-size enforcement requirements.
- Add health status contracts, structured logging redaction requirements, and optional metrics behavior.
- Define backup create/list/restore requirements and integrity validation expectations.
- Define retention/consolidation and graceful degradation behaviors for embedding, Qdrant, and SQLite failure modes.
- Define audit-log requirements for write/delete operations and sensitive-operation controls.
- (Audit follow-up 2026-06-05) Require audit/client identity to be derived from the authenticated principal (`req.ip` / bearer-token identity), never from the spoofable `x-client-id` request header.
- (Audit follow-up 2026-06-05) Require consolidation cluster + contradiction detection to be either implemented per its scenarios or explicitly de-scoped — it is currently marked done but unimplemented.
- (Audit follow-up 2026-06-05) Require the SQLite-lock retry/backoff behavior to be either implemented or de-scoped with a documented rationale for sql.js's in-process model.
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
