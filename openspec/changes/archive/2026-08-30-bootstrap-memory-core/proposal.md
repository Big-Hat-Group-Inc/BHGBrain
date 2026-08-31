## Why

The project needs a concrete, implementation-ready baseline for persistent memory behavior before MCP-facing features are added. Defining core memory semantics, namespace isolation, and write decisions first reduces downstream ambiguity and regression risk.

## What Changes

- Introduce a core memory domain capability with strict record schema and memory typing.
- Define namespace and collection isolation rules for read/write/dedup behavior.
- Add a write decision pipeline capability supporting extraction plus deterministic fallback for ADD/UPDATE/DELETE/NOOP outcomes.
- Define baseline storage behavior for SQLite metadata plus Qdrant vector persistence, including consistency expectations between the two stores.

### Audit-driven amendments (2026-06-05)

The 2026-06-05 audit (`codeaudit/bootstrap-memory-core-2026-06-05-02-19.md`) found the
write-decision pipeline has drifted materially from `write-decision-pipeline/spec.md`.
This amendment tightens the spec and adds follow-up tasks so the spec and code agree:

- The classifier MUST be able to emit DELETE per its scenario, or DELETE is de-scoped
  (currently it is typed but never produced).
- The deterministic fallback MUST apply the similarity threshold to choose UPDATE vs
  ADD rather than always ADDing. **Duplication risk:** in the current degraded path,
  every near-duplicate becomes a new ADD, silently inflating storage and diverging from
  the documented merge behavior.
- A missing UPDATE target MUST NOT silently fall through to ADD (which today produces
  duplicates with no observability), and degraded embedding writes MUST be observable.
- Cross-namespace read/write mode and multi-fact extraction are either implemented or
  explicitly de-scoped.

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
