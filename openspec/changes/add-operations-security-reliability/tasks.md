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
- [x] 3.4 Implement retention and consolidation jobs for stale detection, cluster surfacing, and contradiction candidates.
- [x] 3.5 Add outage behavior tests for embedding unavailability, Qdrant fallback, and SQLite lock retry behavior.
