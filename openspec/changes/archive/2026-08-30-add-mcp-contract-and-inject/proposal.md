## Why

With core memory behavior defined, the project needs a strict MCP contract so multiple clients can reliably use the same brain. A complete tool/resource interface plus session-start inject behavior is required to deliver the primary v1 multi-client use case.

## What Changes

- Define strict JSON-schema tool contracts for `remember`, `recall`, `forget`, `search`, `tag`, `collections`, `category`, and `backup`.
- Define standardized error envelope behavior and validation rejection for unknown fields and malformed inputs.
- Add resource contracts for memory/category/collection browsing and health snapshots.
- Define `memory://inject` payload composition, ranking inputs, and response-budget truncation behavior.
- Specify hybrid search ranking using Reciprocal Rank Fusion with configurable weights.

## Capabilities

### New Capabilities
- `mcp-tool-contract`: MCP tool input/output schemas, validation rules, and error envelope behavior.
- `memory-resources`: MCP resource URI behaviors for memory/category/collection/health access patterns.
- `auto-inject-context`: Session-start inject payload construction, ordering, and truncation metadata.
- `hybrid-search-ranking`: Semantic/fulltext/hybrid search modes and RRF result fusion requirements.

### Modified Capabilities
- None.

## Impact

- Affects MCP server interface layer, schema validation modules, and response formatting.
- Defines client-facing behavior that must remain backward compatible across supported MCP clients.
- Requires integration tests for tool schemas, resource rendering, and inject budget handling.
