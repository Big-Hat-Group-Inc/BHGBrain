## 1. Domain Model and Validation

- [x] 1.1 Define TypeScript domain types for canonical memory records, memory types, and category slots.
- [x] 1.2 Implement input normalization and validation for schema constraints (lengths, ranges, enums, defaults).
- [x] 1.3 Add unit tests covering valid and invalid canonical memory payloads.

## 2. Namespace-Scoped Storage Layer

- [x] 2.1 Implement SQLite schema and repositories for memory metadata, tags, and category revision tracking.
- [x] 2.2 Implement Qdrant collection management and vector upsert/read helpers with namespace and collection metadata.
- [x] 2.3 Add consistency checks that ensure successful writes only when both stores commit required records.

## 3. Write Decision Pipeline

- [x] 3.1 Implement extraction stage that emits atomic candidates when extraction is enabled.
- [x] 3.2 Implement candidate decisioning logic for ADD, UPDATE, DELETE, and NOOP using namespace-scoped similarity retrieval.
- [x] 3.3 Implement deterministic fallback mode with checksum and similarity-threshold behavior.
- [x] 3.4 Add integration tests validating ADD/UPDATE/DELETE/NOOP outcomes and deterministic fallback parity.

## Audit follow-ups (2026-06-05)

These items capture spec-to-code drift found in the audit
(`codeaudit/bootstrap-memory-core-2026-06-05-02-19.md`). The write-decision
pipeline has diverged materially from `write-decision-pipeline/spec.md`. For each
item, either implement the specified behavior or de-scope it in the spec — the spec
and code MUST agree.

- [ ] 4.1 DELETE decisioning: the `DELETE` operation is specified and typed but the
  classifier never produces it (`src/pipeline/index.ts:231-247`; `decide()` has no
  DELETE branch). Implement invalidation→DELETE (an extraction/heuristic signal that
  drives `storage.deleteMemory` and stores the correction) **or** de-scope DELETE in
  `write-decision-pipeline/spec.md` and remove it from `WriteOperation`.
- [ ] 4.2 Fallback similarity decisioning: the deterministic fallback always ADDs and
  skips its specified similarity-threshold UPDATE/ADD branching
  (`src/pipeline/index.ts:249-315`). Because fallback is reached precisely when
  embedding failed, it has no vector. Implement a vectorless similarity proxy
  (e.g. FTS/trigram over namespace-scoped candidates) to drive threshold-based
  UPDATE/ADD **or** narrow the spec to checksum-only fallback.
- [ ] 4.3 Missing UPDATE target: an UPDATE whose target row is absent silently falls
  through to ADD, producing a duplicate with no observability
  (`src/pipeline/index.ts:159-188`). Handle the missing target explicitly — throw
  `internal(...)` (mirroring the NOOP branch) or ADD with an explicit `logger.warn`
  recording the cross-store drift.
- [ ] 4.4 Multi-fact extraction: `extract()` is a stub; both branches return one
  candidate and the "Full LLM extraction would…" comment is misleading
  (`src/pipeline/index.ts:60-83`). Implement model-backed multi-candidate extraction
  **or** collapse the branches, replace the comment with an honest TODO, and de-scope
  the multi-candidate scenario in the spec.
- [ ] 4.5 `searchSimilar` error handling: the dedup similarity read swallows ALL errors
  and returns `[]` (`src/storage/qdrant.ts:173-193`), so a transient Qdrant fault is
  indistinguishable from "no matches" and yields a silent duplicate ADD. Distinguish
  collection-not-found from transport errors, route through the circuit breaker, and
  surface/log real failures.
- [ ] 4.6 Cross-namespace read/write mode: no explicit cross-namespace mode exists;
  `searchSimilar` always filters to one namespace
  (`src/storage/qdrant.ts:185`), leaving the cross-namespace scenario in
  `core-storage-consistency/spec.md` unimplemented. Implement the explicit mode **or**
  de-scope it.
- [ ] 4.7 Complete Task 3.4 integration tests for the above: UPDATE merge path, DELETE
  behavior, and deterministic-fallback parity (UPDATE/ADD/NOOP) — the current suite
  covers only NOOP, missing-NOOP-target, and degraded ADD.
- [ ] 4.8 Observability for degraded writes: emit a structured
  `logger.warn`/metric when the embedding-failure fallback engages
  (`src/pipeline/index.ts:122-130`) so silent degraded (no-vector) writes are visible.
