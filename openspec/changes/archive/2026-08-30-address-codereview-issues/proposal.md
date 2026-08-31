## Why

The current code review identifies multiple correctness, durability, security, and MCP contract gaps that can cause misleading behavior under load or in degraded environments. These issues should be captured as explicit requirements so implementation and verification can be tracked against a clear contract.

## What Changes

- Define requirements to eliminate read-path full-database flushes and reduce synchronous persistence overhead.
- Define atomicity guarantees for cross-store update flows between SQLite and Qdrant.
- Require durable commit semantics for all mutating tool paths, starting with category mutations.
- Require fail-closed authentication behavior for externally reachable HTTP deployments.
- Define MCP-compliant structured tool/resource response contracts and template discovery behavior.
- Define degraded embedding startup/runtime behavior, plus low-cost health/readiness semantics.
- Define search and resource correctness requirements for collection scoping, stable pagination, dependency error propagation, and bounded metrics/storage write safety.

## Capabilities

### New Capabilities
- `read-path-persistence-efficiency`: Prevent read operations from triggering full synchronous database writes.
- `cross-store-update-atomicity`: Keep SQLite/Qdrant updates consistent under partial failures.
- `durable-mutation-acknowledgement`: Ensure mutating tool success responses are durably persisted.
- `fail-closed-http-auth`: Enforce secure auth defaults when HTTP is externally reachable.
- `mcp-structured-contracts`: Use structured MCP tool/resource contracts and template discovery.
- `degraded-embedding-and-health-semantics`: Support degraded startup/runtime and low-cost health probes.
- `search-resource-consistency-and-observability`: Tighten search scoping, pagination stability, dependency surfacing, bounded metrics, and atomic file writes.

### Modified Capabilities
- None.

## Impact

- Affected systems: storage persistence (`sql.js` behavior), transport/auth middleware, tool handlers, MCP stdio responses, resource discovery, search ranking/filtering, health/metrics, backup/database write paths.
- Affected code areas include `src/storage/*`, `src/tools/*`, `src/transport/*`, `src/index.ts`, `src/resources/*`, `src/search/*`, `src/health/*`, and `src/backup/*`.
- Operational impact: lower request latency risk, clearer failure modes, improved interoperability with MCP clients, and stronger security defaults.
