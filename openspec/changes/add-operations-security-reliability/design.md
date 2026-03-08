## Context

The specification requires secure local-default operation with explicit degraded-state behavior and operational controls. These concerns cross transport, middleware, storage orchestration, and scheduled background jobs, so they need a separate design and execution plan.

## Goals / Non-Goals

**Goals:**
- Enforce transport/auth defaults and protective limits for HTTP operation.
- Implement observable runtime state via health endpoints, structured logs, and optional metrics.
- Implement backup and restore flows with integrity checks and sensitive-data handling.
- Implement retention and consolidation jobs plus explicit degraded/unhealthy state transitions.

**Non-Goals:**
- Full cloud deployment automation.
- Encryption at rest and multi-user role systems.
- Custom observability backend integrations beyond standard metrics exposure.

## Decisions

1. Middleware-first enforcement for auth, rate, and payload limits.
Rationale: Shared middleware guarantees consistent behavior across all tool/resource endpoints.
Alternative considered: Endpoint-local checks. Rejected due to duplication and bypass risk.

2. Health model with component-level status plus overall aggregate.
Rationale: Component statuses (`sqlite`, `qdrant`, `embedding`) explain degraded states directly to clients and operators.
Alternative considered: Single boolean health flag. Rejected because it cannot distinguish degraded from unhealthy states.

3. Backup artifacts include both metadata and vector state snapshots.
Rationale: Restores must be complete and integrity-checkable; SQLite-only backups are insufficient.
Alternative considered: Metadata-only backups with re-embedding rebuild. Rejected due to long recovery time and possible data loss.

4. Explicit failure-mode mapping to error codes and retry semantics.
Rationale: Predictable outages are required for clients to react safely (`EMBEDDING_UNAVAILABLE`, retries on locks, etc.).
Alternative considered: Generic internal errors for all failures. Rejected because it hides operator and client recovery options.

## Risks / Trade-offs

- [Rate limits affect bursty local workloads] -> Mitigate with configurable defaults and clear limit headers.
- [Verbose logs may leak sensitive payloads] -> Mitigate by default redaction of tokens and memory previews.
- [Backup restore can overwrite valid state] -> Mitigate with confirmation gates and pre-restore snapshot creation.
- [Consolidation may collapse distinct memories] -> Mitigate with conservative thresholds and manual review controls.
