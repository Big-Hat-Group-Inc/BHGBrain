## Why

Several read paths do avoidable work: search hydrates results one row at a time, read requests persist access metadata per hit, and auto-inject assembles large transient strings only to truncate them. These issues increase latency and garbage churn as the memory set grows.

## What Changes

- Define bulk hydration and bounded read-path persistence behavior for search.
- Define budget-aware auto-inject assembly so large category content is not fully materialized before truncation.
- Keep read-path behavior scalable without changing user-visible semantics.

## Capabilities

### New Capabilities
- `search-read-hydration-efficiency`: Search hydrates memory rows and access metadata efficiently.
- `auto-inject-budgeted-assembly`: Auto-inject builds context within budget without oversized transient allocations.

### Modified Capabilities
- `read-path-persistence-efficiency`: Extended from flush avoidance to broader read-path scaling behavior.

## Impact

- Affected code: `src/search/index.ts`, `src/resources/index.ts`, `src/storage/sqlite.ts`.
- Performance: lower query overhead and reduced heap churn for common read flows.
