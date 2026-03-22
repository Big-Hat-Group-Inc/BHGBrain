## Context

The review found three related collection-scope defects. Search semantics are inconsistent when `collection` is omitted, because fulltext search stays namespace-wide while vector-backed search silently falls back to `general`. Exact checksum deduplication is namespace-scoped instead of collection-scoped. The `collection://{name}` resource also truncates the newest namespace results before filtering, which can omit valid collection members.

These are cross-cutting problems across search, storage, pipeline, tools, and resources. The design needs to align read and write behavior without forcing a disruptive storage migration.

## Goals / Non-Goals

**Goals:**
- Define one consistent rule for namespace-versus-collection behavior across retrieval and deduplication.
- Preserve the current API shape where `collection` remains optional.
- Eliminate silent fallback to `general` when omitted-collection retrieval is requested.
- Make collection resources query collection-scoped rows directly and support complete results.

**Non-Goals:**
- Redesigning the namespace model or changing the public tool schemas.
- Repacking all vectors into a new Qdrant collection layout.
- Changing dedup scoring thresholds beyond scope alignment.

## Decisions

1. Treat omitted `collection` as namespace-wide behavior at the service contract layer.
- Decision: `search` and `recall` without a `collection` SHALL operate across all collections in the namespace, regardless of backend.
- Rationale: this matches current fulltext behavior and user expectations from the optional parameter.
- Alternative considered: redefine omitted `collection` to mean `general`. Rejected because it would silently narrow results and formalize the current bug.

2. Implement namespace-wide vector retrieval as fan-out plus merge, not a storage migration.
- Decision: when no collection is supplied, the search layer will enumerate known collections in the namespace, query each vector collection, and merge/rerank results before hydration.
- Rationale: it preserves the existing Qdrant layout and avoids a data migration or dual-write transition.
- Alternative considered: migrate to one Qdrant collection per namespace. Rejected because it is more invasive and unnecessary for this correctness fix.

3. Make exact checksum dedup collection-aware.
- Decision: exact deduplication SHALL key on `(namespace, collection, checksum)` instead of `(namespace, checksum)`.
- Rationale: write behavior should respect the same collection boundary that near-dedup and collection resources use.
- Alternative considered: keep exact dedup namespace-wide and document it. Rejected because it would preserve a surprising mismatch between exact and semantic dedup paths.

4. Add direct collection-scoped listing in storage for resources.
- Decision: the resource layer will use a dedicated collection query with pagination instead of loading a namespace slice and filtering in memory.
- Rationale: the current truncation-before-filtering behavior cannot produce correct results for larger namespaces.
- Alternative considered: increase the namespace slice from 50 to a larger number. Rejected because it remains incomplete and unbounded.

## Risks / Trade-offs

- [Namespace-wide vector fan-out can be slower in namespaces with many collections] -> Mitigation: query only collections known to SQLite, cap per-collection fetch size, and merge only the top candidates needed for the final limit.
- [Collection-aware exact dedup changes write outcomes for existing clients] -> Mitigation: treat the change as an intentional contract correction and cover it with regression tests.
- [Merged ranking across collections can introduce ordering edge cases] -> Mitigation: preserve the existing hydration and ranking pipeline after fan-out so collection origin does not change score normalization rules unnecessarily.

## Migration Plan

1. Add storage helpers for collection-scoped checksum lookup and collection-scoped listing with pagination.
2. Update search service and Qdrant access paths to support namespace-wide omitted-collection retrieval.
3. Update write pipeline exact dedup to use collection-aware lookup.
4. Update collection resource handling to use direct collection queries.
5. Add regression tests for omitted-collection semantic/hybrid search, cross-collection exact dedup, and collection resource completeness.

## Open Questions

- Should namespace-wide semantic fan-out remain purely sequential at first, or should it issue collection queries concurrently once correctness is in place?
