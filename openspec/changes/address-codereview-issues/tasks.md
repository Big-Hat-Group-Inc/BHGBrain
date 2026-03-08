## 1. Persistence and Consistency Foundations

- [x] 1.1 Remove read-path synchronous full-db flushes and introduce bounded async access-metadata persistence.
- [x] 1.2 Implement atomic/rollback-safe cross-store update flow for SQLite + Qdrant update paths.
- [x] 1.3 Add tests for no read-path flush behavior and cross-store failure consistency.

## 2. Durability and Security Contracts

- [x] 2.1 Ensure category mutations flush durably before success responses.
- [x] 2.2 Add fail-closed HTTP startup checks for external binding without auth.
- [x] 2.3 Add explicit unauthenticated HTTP opt-in configuration with warning logs.
- [x] 2.4 Add tests for durability guarantees and auth startup policy.

## 3. MCP Contract Compliance

- [x] 3.1 Update MCP tool call responses to include structured outputs and explicit error signaling.
- [x] 3.2 Introduce MCP resource templates for parameterized URIs.
- [x] 3.3 Add interoperability tests covering structured tool outputs and resource template discovery.

## 4. Degraded Runtime and Health

- [x] 4.1 Implement degraded embedding startup mode and request-time dependency errors.
- [x] 4.2 Replace per-probe live embedding health checks with cached/lightweight readiness strategy.
- [x] 4.3 Add tests for degraded startup and low-cost health probe behavior.

## 5. Search/Resource Correctness and Operational Safety

- [x] 5.1 Add collection-aware filtering to fulltext/hybrid search candidate selection.
- [x] 5.2 Implement stable composite cursor pagination for `memory://list`.
- [x] 5.3 Surface Qdrant dependency failures explicitly in semantic paths.
- [x] 5.4 Bound metrics memory usage and emit clearer metric semantics.
- [x] 5.5 Switch DB/backup persistence writes to atomic replace flow.
- [x] 5.6 Add regression tests for scoping, pagination stability, dependency surfacing, and atomic write safety.

## 6. Documentation and Rollout

- [x] 6.1 Document new auth, degraded-mode, and MCP response contracts.
- [x] 6.2 Document search/pagination semantics and operational observability expectations.
