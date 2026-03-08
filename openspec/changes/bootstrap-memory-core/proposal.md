## Why

The project needs a concrete, implementation-ready baseline for persistent memory behavior before MCP-facing features are added. Defining core memory semantics, namespace isolation, and write decisions first reduces downstream ambiguity and regression risk.

## What Changes

- Introduce a core memory domain capability with strict record schema and memory typing.
- Define namespace and collection isolation rules for read/write/dedup behavior.
- Add a write decision pipeline capability supporting extraction plus deterministic fallback for ADD/UPDATE/DELETE/NOOP outcomes.
- Define baseline storage behavior for SQLite metadata plus Qdrant vector persistence, including consistency expectations between the two stores.

## Capabilities

### New Capabilities
- `memory-domain-model`: Canonical memory schema, memory types, categories, and namespace/collection semantics.
- `write-decision-pipeline`: Candidate extraction and ADD/UPDATE/DELETE/NOOP decision logic with deterministic fallback behavior.
- `core-storage-consistency`: Core persistence guarantees and store coordination between SQLite metadata and Qdrant vectors.

### Modified Capabilities
- None.

## Impact

- Affects server-side memory write/read services and repository layout for domain modules.
- Establishes required validation and normalization behavior used by all MCP tools.
- Requires SQLite schema setup and Qdrant collection management for namespace-scoped memory operations.
