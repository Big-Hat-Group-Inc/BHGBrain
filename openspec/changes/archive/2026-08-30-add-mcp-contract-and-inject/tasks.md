## 1. Tool Contracts and Validation

- [x] 1.1 Implement JSON schema definitions for all v1 tools with strict `additionalProperties: false` behavior.
- [x] 1.2 Implement a shared validation layer that maps validation failures to `INVALID_INPUT` envelope responses.
- [x] 1.3 Implement standardized success payload serializers for each tool contract.

## 2. Resource Handlers and Inject Pipeline

- [x] 2.1 Implement resource handlers for memory, category, collection, and health URIs.
- [x] 2.2 Implement `memory://inject` composition pipeline with category-first ordering and top-k recall insertion.
- [x] 2.3 Implement inject and response budget truncation with `truncated` and `total_results` metadata.

## 3. Search and Contract Testing

- [x] 3.1 Implement semantic, fulltext, and hybrid search mode routing.
- [x] 3.2 Implement RRF-based hybrid ranking with configurable semantic/fulltext weights.
- [x] 3.3 Add contract tests for all tool schemas and error envelopes.
- [x] 3.4 Add integration tests for resource responses and inject budget behavior.
