# Code Audit — OpenSpec proposal `bootstrap-memory-core`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `bootstrap-memory-core`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM (`.js` import extensions), Zod config, Pino, Vitest, sql.js + Qdrant
- **Files reviewed:** 14 (proposal.md, tasks.md, design.md, 3 spec.md; src/domain/{types,schemas,normalize,lifecycle}.ts, src/pipeline/{index,parser}.ts, src/storage/{index,qdrant,sqlite}.ts, plus co-located tests)

## Executive summary

The implementation broadly satisfies the proposal: the canonical memory schema, namespace/collection defaults, memory-type enums, category versioning, dual-store consistency with compensation, and a deterministic dedup pipeline are all present and tested. The most material gap is **spec drift in the write-decision pipeline**: the `DELETE` operation defined in `write-decision-pipeline/spec.md` is never produced by the classifier, multi-fact extraction is a stub, and the deterministic fallback skips its specified checksum-NOOP / similarity-UPDATE behavior (it always ADDs). These are behavioral gaps, not crashes. No Critical security issues were found. Headline counts: 0 Critical, 1 High, 5 Medium, 3 Low.

## Spec compliance

| Requirement / Task | Status | Evidence |
| ------------------ | ------ | -------- |
| **memory-domain-model:** Canonical schema persisted | Done | `src/domain/types.ts:26-52` (`MemoryRecord`), `src/storage/sqlite.ts:341-379` (insert) |
| — Invalid canonical fields rejected | Done | `src/domain/schemas.ts:26-36`, `schemas.test.ts:32-55` |
| **memory-domain-model:** Memory type constrained to episodic/semantic/procedural | Done | `src/domain/schemas.ts:6`, `src/domain/types.ts:1` |
| — Accepted type preserved; unknown rejected | Done | `RememberInputSchema` type field; pipeline persists `resolvedType` `src/pipeline/index.ts:141,201` |
| **memory-domain-model:** Category persistent policy slots (company-values/architecture/coding-requirements/custom) | Done | `src/domain/schemas.ts:7`, `src/storage/sqlite.ts:870-887` |
| — Category versioned on update (increment revision + timestamp) | Done | `src/storage/sqlite.ts:876` (`revision = revision + 1`) |
| — Category entries excluded from decay/consolidation deletion | Partial | Consolidation/stale paths exclude `category IS NULL` (`src/storage/sqlite.ts:590,597`), **but** expiry sweep `getExpiredMemories` keys only off `decay_eligible`/`expires_at` (`sqlite.ts:695-696`); category memories rely on the T0 tier setting `decay_eligible=0` rather than an explicit category guard |
| **memory-domain-model:** Namespace defaults `global`, collection `general` | Done | `src/domain/schemas.ts:28-29` (`.default('global')`, `.default('general')`) |
| **core-storage-consistency:** Writes namespace-scoped by default | Done | `getMemoryByChecksum` scopes by namespace `sqlite.ts:497`; Qdrant filter `must namespace` `qdrant.ts:185` |
| — Explicit cross-namespace mode | Drifted | No cross-namespace write/read mode exists in the audited surface; `searchSimilar` always filters to one namespace `qdrant.ts:185`. Spec scenario unimplemented |
| **core-storage-consistency:** SQLite+Qdrant logically consistent; no success on partial failure | Done | `src/storage/index.ts:27-43` (Qdrant failure throws, marks `vector_synced=false` for reconciliation); `index.test.ts:110-120` |
| — Partial write triggers rollback/compensation | Done | writeMemory compensation via `markVectorSync(false)` + `reconcileVectorsFromSqlite` `index.ts:36-39,204-258`; updateMemory true rollback `index.ts:93-98` |
| **core-storage-consistency:** Embedding-space compatibility per collection | Done | `ensureCollectionCompatible` `src/storage/index.ts:281-298`; throws `conflict` on model/dim mismatch |
| **write-decision-pipeline:** Extraction into atomic candidates | Drifted | `extract()` returns a single candidate in both branches; multi-fact split is a stub `src/pipeline/index.ts:60-83` |
| — Extraction disabled → single candidate | Done | `src/pipeline/index.ts:66-73` |
| **write-decision-pipeline:** Classify ADD/UPDATE/DELETE/NOOP | Drifted | `classifyOperation` only emits ADD/UPDATE/NOOP; **DELETE is never produced** `src/pipeline/index.ts:231-247` |
| — No equivalent → ADD | Done | `src/pipeline/index.ts:235,246` |
| — Refinement → UPDATE (preserve identity) | Done | `src/pipeline/index.ts:159-188` |
| — Invalidation → DELETE | Missing | No DELETE path in classifier or `decide()` |
| — Redundant → NOOP (return existing id) | Done | `src/pipeline/index.ts:145-157,240-242` |
| **write-decision-pipeline:** Deterministic fallback without models | Partial | `deterministicFallback` exists `src/pipeline/index.ts:249-315` but only triggers on embedding error and always ADDs |
| — Exact checksum match → NOOP in fallback | Done (indirectly) | Checksum NOOP runs before embedding for all paths `src/pipeline/index.ts:109-119`, so it applies in fallback too |
| — High-similarity → UPDATE in fallback | Missing | Fallback has no vector, so no similarity check; always ADD `src/pipeline/index.ts:263,308-314` |
| — Below-threshold → ADD in fallback | Done (vacuously) | Always ADD `src/pipeline/index.ts:308-314` |
| **Task 1.1** Domain types | Done | `src/domain/types.ts` |
| **Task 1.2** Normalization/validation | Done | `src/domain/normalize.ts`, `src/domain/schemas.ts` |
| **Task 1.3** Unit tests valid/invalid payloads | Done | `src/domain/schemas.test.ts`, `normalize.test.ts` |
| **Task 2.1** SQLite schema/repos incl. category revision tracking | Done | `src/storage/sqlite.ts` (memories, categories, memory_revisions) |
| **Task 2.2** Qdrant collection mgmt + namespace metadata | Done | `src/storage/qdrant.ts:38-95` |
| **Task 2.3** Both-store-commit consistency checks | Done | `src/storage/index.ts:21-43` |
| **Task 3.1** Extraction stage emitting candidates | Partial | Stubbed single-candidate `src/pipeline/index.ts:60-83` |
| **Task 3.2** ADD/UPDATE/DELETE/NOOP decisioning | Partial | DELETE missing `src/pipeline/index.ts:231-247` |
| **Task 3.3** Deterministic fallback (checksum + similarity-threshold) | Partial | Checksum yes; similarity-threshold in fallback absent `src/pipeline/index.ts:249-315` |
| **Task 3.4** Integration tests for all outcomes + fallback parity | Partial | `pipeline/index.test.ts` covers NOOP, fallback-ADD, missing-NOOP-target; **no UPDATE, DELETE, or fallback-UPDATE/NOOP-parity tests** |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
| - | -------- | ---------- | ------ | --------- | -------- | ------- |
| 1 | High | High | M | Maintainability | `src/pipeline/index.ts:231-247` | DELETE operation specified but never classified |
| 2 | Medium | High | M | Stability | `src/pipeline/index.ts:249-315` | Deterministic fallback drops specified similarity decisioning; always ADD |
| 3 | Medium | High | S | Maintainability | `src/pipeline/index.ts:60-83` | `extract()` is a stub; both branches identical, dead comment |
| 4 | Medium | Medium | S | Stability | `src/pipeline/index.ts:159-188` | UPDATE silently falls through to ADD when target row vanishes |
| 5 | Medium | High | S | Logging | `src/pipeline/index.ts:122-130` | Embedding failure → silent degraded write, no log/metric |
| 6 | Medium | Medium | S | Performance | `src/storage/index.ts:73-74` | Revision count via full `listRevisions(id).length` on every T0 update |
| 7 | Low | High | S | Testing | `src/pipeline/index.test.ts` | No UPDATE/DELETE/fallback-parity integration tests (Task 3.4) |
| 8 | Low | Medium | S | Stability | `src/storage/qdrant.ts:173-193` | `searchSimilar` swallows all errors → silent ADD on transient Qdrant faults |
| 9 | Low | Low | S | Security | `src/storage/qdrant.ts:34-35` | Namespace/collection interpolated into Qdrant collection name without separator escaping |

## Quick wins

- **#3** Collapse or implement `extract()`; remove the misleading "Full LLM extraction would…" comment so the stub isn't mistaken for working multi-fact extraction (`src/pipeline/index.ts:60-83`).
- **#5** Add a `logger.warn`/metric when `fallback_to_threshold_dedup` engages, so silent degraded writes are observable (`src/pipeline/index.ts:122-130`).
- **#6** Add a `countRevisions(id)` query instead of materializing the full revision list to compute `.length` (`src/storage/index.ts:73-74`).

## Performance

### [Medium · Medium · S] T0 update loads entire revision history to compute next revision number — `src/storage/index.ts:73-74`
**Issue:** On every content change to a T0 memory, `updateMemory` calls `this.sqlite.listRevisions(id).length + 1` to derive the next revision number. `listRevisions` runs `SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC` and fully materializes every prior revision row (including full content blobs) just to count them.
**Why it matters:** For frequently-refined T0 entries (architecture/policy) the revision table grows unbounded, and each update pays an O(n) scan plus full-content deserialization to obtain a single integer. It also races: two concurrent updates can compute the same next revision (mitigated only by the `UNIQUE(memory_id, revision)` constraint, which would throw rather than retry).
**Recommendation:** Use `SELECT MAX(revision)` (or `COUNT(*)`) directly in SQL; or `INSERT … SELECT COALESCE(MAX(revision),0)+1`. Avoid loading content blobs purely to count rows.

## Logging & observability

### [Medium · High · S] Embedding failure silently degrades to vectorless write with no log or metric — `src/pipeline/index.ts:122-130`
**Issue:** When `this.embedding.embed()` throws and `fallback_to_threshold_dedup` is enabled, the pipeline routes to `deterministicFallback` and returns a normal `ADD` result. No log, warning, or metric records that the system entered degraded (no-vector) mode.
**Why it matters:** This is exactly the graceful-degradation path the design calls out (design.md Decision 4), and the design's own risk list flags "operation telemetry for tuning." Without observability, operators cannot tell that recall quality is silently degraded for a window of writes, nor that an embedding provider is down. The resulting rows carry `vector_synced=false` and depend on later reconciliation that no one is alerted to.
**Recommendation:** Emit a structured `logger.warn({ event: 'embedding_degraded_write', memory_id, namespace })` and ideally a counter metric when the fallback path is taken. The `WritePipeline` currently has no logger injected — thread one through the constructor.

## Stability & reliability

### [Medium · High · M] Deterministic fallback omits the specified similarity-threshold decisioning — `src/pipeline/index.ts:249-315`
**Issue:** `write-decision-pipeline/spec.md` requires that fallback mode classify "High-similarity candidate yields UPDATE" and "Below-threshold yields ADD." The implemented `deterministicFallback` has no vector (it is reached precisely because embedding failed), performs no similarity retrieval, and unconditionally ADDs. Only the checksum-NOOP guard (which runs earlier, before embedding, `index.ts:109-119`) carries over.
**Why it matters:** The spec's stated value of fallback parity ("deterministic fallback parity," tasks.md 3.4, design Decision 3) is not met: in degraded mode every near-duplicate becomes a new ADD, producing duplicate memories that the normal path would have merged. This diverges from documented behavior and inflates storage.
**Recommendation:** Either (a) implement a vectorless similarity proxy (e.g. FTS/trigram similarity against namespace-scoped candidates) to drive UPDATE/ADD in fallback, or (b) explicitly amend the spec to scope fallback to checksum-only dedup. Today the code and spec disagree.

### [Medium · Medium · S] UPDATE classification can silently fall through to ADD — `src/pipeline/index.ts:159-188`
**Issue:** When `classifyOperation` returns `UPDATE` with a `targetId`, the code fetches `getMemoryById(targetId)`. If `existing` is falsy (target row missing despite Qdrant returning it — e.g. SQLite/Qdrant drift), the `if (existing)` block is skipped and execution falls through to the ADD path at line 191. Contrast with the NOOP branch (`index.ts:147-149`), which throws `internal(...)` on a missing target.
**Why it matters:** A drifted store silently converts an intended UPDATE into a new duplicate ADD, masking the very cross-store divergence the design lists as its top risk, with no error surfaced.
**Recommendation:** Mirror the NOOP branch: throw `internal('UPDATE target … not found')` (or fall back to ADD *with an explicit warning log*) so the divergence is observable rather than silently duplicated.

### [Low · Medium · S] `searchSimilar` swallows every Qdrant error and returns empty → silent ADD — `src/storage/qdrant.ts:173-193`
**Issue:** `searchSimilar` wraps the whole search in `try { … } catch { return []; }`. A transient Qdrant outage or timeout is indistinguishable from "no similar memories," so the pipeline classifies ADD (`index.ts:235`) and persists a potential duplicate. Unlike the other Qdrant methods, this call is not routed through the circuit breaker (`executeWithBreaker`).
**Why it matters:** Dedup correctness silently degrades during Qdrant instability, again producing duplicates without any signal. The empty-on-error behavior also defeats the breaker's purpose for this read path.
**Recommendation:** Distinguish "collection-not-found" (legitimately empty) from transport errors; let real errors propagate (or route through the breaker and into the documented fallback) rather than masquerading as zero results.

## Security

### [Low · Low · S] Namespace/collection interpolated into Qdrant collection names without delimiter escaping — `src/storage/qdrant.ts:34-35`
**Issue:** `collectionName` builds `bhgbrain_${namespace}_${collection}`. The namespace regex permits `/` and `-` and the collection name permits a broad `NameSchema` (`.max(100)`), so `namespace="a_b"` + `collection="c"` and `namespace="a"` + `collection="b_c"` both produce `bhgbrain_a_b_c` — an ambiguity/collision rather than an injection. No SQL/command injection vector exists here (Qdrant client treats it as an opaque name, and SQLite uses parameter binding throughout).
**Why it matters:** Two distinct (namespace, collection) pairs can map to one physical Qdrant collection, leaking vectors across namespace boundaries — directly contradicting the "namespace isolation" guarantee. Low confidence because exploitability depends on naming conventions in practice.
**Recommendation:** Use a reversible delimiter that cannot appear in either component (e.g. encode `_` or use a non-permitted separator), or hash the (namespace, collection) tuple into the physical name.

## Maintainability & code quality

### [High · High · M] DELETE operation is specified but never produced by the pipeline — `src/pipeline/index.ts:231-247`
**Issue:** `WriteOperation` includes `DELETE` (`src/domain/types.ts:7`) and `write-decision-pipeline/spec.md` defines a required scenario ("Candidate invalidation results in DELETE … removes the stale memory while storing the correction"). `classifyOperation` returns only `ADD`, `UPDATE`, or `NOOP`; `decide()` has no DELETE branch. The capability is declared, typed, and tested-for-shape, but the behavior does not exist.
**Why it matters:** This is the largest spec-to-code drift in the proposal. Downstream MCP tools and callers may reasonably expect a candidate that invalidates a prior fact to remove it; instead the contradicting content is simply ADDed alongside the stale memory. Because it is a deliberate spec requirement (not an optional one), it should be either implemented or explicitly deferred in the spec.
**Recommendation:** Implement an invalidation signal (e.g. extraction-emitted "this corrects/deletes X" or a negation heuristic in fallback) that drives a DELETE through `storage.deleteMemory`, or amend the spec/tasks to mark DELETE as out-of-scope for v1 with a tracking change.

### [Medium · High · S] `extract()` is a no-op stub with duplicated branches and misleading comments — `src/pipeline/index.ts:60-83`
**Issue:** Both the `extraction_enabled === false` and the enabled branch return the identical single candidate. The "Full LLM extraction would use the extraction model to split content" comment implies functionality that does not exist, and `config.pipeline.extraction_model` (`src/config/index.ts:152`) is configured but unused by this path.
**Why it matters:** The multi-candidate scenario in the spec ("Extraction enabled creates multiple candidates") cannot pass. The dead branch and aspirational comments make future maintainers believe extraction is wired up. Configuration (`extraction_model`, `extraction_model_env`) advertises a capability the code never invokes.
**Recommendation:** Collapse to a single return (extraction currently has no effect) and replace the comment with an honest TODO referencing the deferred work, or implement model-backed extraction. Keep config and behavior in sync.

## Testing & coverage

### [Low · High · S] No integration tests for UPDATE, DELETE, or fallback decision parity (Task 3.4) — `src/pipeline/index.test.ts`
**Issue:** `pipeline/index.test.ts` covers NOOP, the missing-NOOP-target error, and the embedding-unavailable degraded ADD. It does **not** test the UPDATE classification/merge path (`index.ts:159-188`), any DELETE behavior, or the deterministic-fallback "parity" that tasks.md 3.4 explicitly requires. The UPDATE-falls-through-to-ADD hazard (finding #4) is consequently uncaught.
**Why it matters:** The pipeline is the proposal's behavioral core, and its highest-risk branches (UPDATE merge, drift handling, fallback decisioning) are unverified. Task 3.4 is only partially satisfied.
**Recommendation:** Add cases: similarity in the UPDATE band asserts `updateMemory` + merged tags + `importance = max(...)`; a drifted UPDATE target asserts the chosen behavior (throw vs logged ADD); and at least one fallback case asserting parity with the spec's intended classification.

## Dependencies & supply chain

No issues found. The proposal's audited surface relies on already-vetted, pinned-by-lockfile first-party dependencies (`uuid`, `@qdrant/js-client-rest`, `zod`, `node:crypto`); no new or loosely-ranged dependency is introduced by this change.

## Recommendations (prioritized)

1. **Resolve the DELETE drift (#1, High).** Either implement invalidation→DELETE in the pipeline or amend `write-decision-pipeline/spec.md` and `tasks.md` to defer it explicitly. The spec and code must agree.
2. **Make degraded/fallback behavior observable and correct (#2, #5).** Add structured logging + a metric when the embedding-failure fallback engages, and either implement vectorless similarity dedup in fallback or narrow the spec to checksum-only.
3. **Eliminate silent UPDATE→ADD fall-through (#4) and search-error masking (#8).** Throw or log on missing UPDATE targets; stop `searchSimilar` from treating transport errors as "no matches."
4. **Honest extraction stub (#3).** Collapse the duplicated branches and remove aspirational comments, or wire up the configured extraction model.
5. **Close the pipeline test gap (#7).** Cover UPDATE, drift handling, and fallback parity to satisfy Task 3.4.
6. **Low-risk cleanups:** revision-count query (#6) and Qdrant collection-name delimiter ambiguity (#9).
