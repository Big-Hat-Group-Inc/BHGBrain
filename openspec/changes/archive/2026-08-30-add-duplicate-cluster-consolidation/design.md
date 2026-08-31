## Context

Write-time dedup is deliberately narrow: `WritePipeline.process` embeds the incoming
candidate, fetches the top-10 similar existing memories scoped to the same
namespace/collection/tier via `QdrantStore.searchSimilar` (`src/storage/qdrant.ts:234-270`),
and `classifyOperation` (`src/pipeline/index.ts:291-318`) only ever looks at
`similar[0]` against tier-specific thresholds from `MemoryLifecycleService.dedupThresholdFor`
(`src/domain/lifecycle.ts:101-120`, e.g. T0/T1 UPDATE at `max(base, 0.95)`, T3 at
`max(base, 0.9)`). This is correct and sufficient for "does this new write duplicate
something," but it never runs the other direction: nothing ever asks whether two
memories that *already* exist are near-duplicates of each other. `import`
(`src/tools/import.ts`) writes many memories from one document in one call, and the
degraded-window fallback (`src/pipeline/index.ts:353-377`, checksum/Jaccard instead of
cosine similarity) is looser than the normal path — both routinely leave near-dupes
that write-time dedup structurally cannot catch after the fact.

The precedent for a human-approved lifecycle action closing a write/read gap is
`add-review-and-archive-recall`'s `review` tool: it added `list`/`keep`/`archive`/
`restore` actions over `review_due` and `archived_memories`, both of which already had
write paths but no MCP-facing read/action surface (`src/tools/index.ts:287-455`). This
proposal follows the same shape — add the missing read+action surface, don't touch the
write pipeline — and reuses its `archive` action's transition code
(`src/tools/index.ts:356-392`: `sqlite.archiveMemory` + `storage.deleteMemory`, with a
try/catch that deletes the archive row if the vector/SQLite removal fails, so a memory
is never left both live and archived).

## Goals / Non-Goals

Goals:
- Discover clusters of near-duplicate *existing* memories, bounded and paginated per
  call regardless of store size.
- Merge a human-chosen cluster into one target memory via one explicit action, with no
  automatic or scheduled merge path.
- Reuse existing lineage (`merged_from`) and archive-transition machinery rather than
  inventing new storage concepts.

Non-Goals:
- No content synthesis: `merge` never rewrites the target's `content`. Which cluster
  member's phrasing survives is the human's choice (`target_id`), not something the
  tool infers or blends. Content synthesis across a cluster is exactly what episodic→
  semantic distillation (brainstorm 3.2) would add later, on top of this substrate.
- No automatic/scheduled consolidation. `list` is read-only and side-effect free;
  `merge` never runs without an explicit `target_id` + `source_ids` from a caller who
  has seen the cluster (typically from a prior `list` call, though `merge` does not
  require having called `list` first — it validates its own inputs independently).
- No cross-collection or cross-namespace merges. A cluster's members must share both
  `namespace` and `collection`; `list` scans one namespace/collection pair per call
  (matching `searchSimilar`'s own scoping), and `merge` rejects mixed-collection input.
- No exact pairwise (O(n²)) comparison. See Decisions below.

## Decisions

- **Neighbor discovery via Qdrant's own per-point ANN query, not a full pairwise
  scan.** `list` does not fetch all vectors and compare every pair. Instead it adds a
  `findNeighborsById(namespace, collection, pointId, topK, minScore)` method to
  `QdrantStore` that calls the same `client.query` endpoint `search`/`searchSimilar`
  already use (`src/storage/qdrant.ts:206`, `242`), but with `query: pointId` instead
  of `query: vector` — Qdrant's Query API (`QueryRequest.query: QueryInterface`,
  confirmed in the pinned `@qdrant/js-client-rest@~1.19.0` types) accepts an existing
  point's id directly and searches using its stored vector server-side, so no vector
  ever needs to be fetched or held client-side. This turns candidate discovery into
  `O(n · top_k)` bounded ANN queries (one per scanned memory, each `O(log n)`-ish via
  HNSW) instead of `O(n²)` cosine comparisons — see Risks for why this specific choice
  was picked over the brainstorm's literal "pairwise ≥0.9" wording.
- **`list` scans one namespace/collection pair, paginated via the existing
  `sqlite.listMemories(namespace, limit, cursor)` cursor** (`src/storage/sqlite.ts:82`,
  `662`) to pick the page of candidate ids to probe, capped by
  `consolidation.max_scan_per_call`. A single call is always bounded; a large
  namespace/collection needs repeated `list` calls to fully scan, mirroring `review
  list`'s own pagination contract.
- **Clustering is union-find over the page's neighbor edges**, not a persisted
  "report." No new table: clusters are computed on demand and returned in the response,
  the same ephemeral-result shape `review list` uses for its due-memory page. Each
  cluster carries a `suggested_target` (highest `importance`, tie-broken by
  `access_count` then most recent `updated_at`) as a hint only — `merge` requires the
  caller to name `target_id` explicitly regardless of the suggestion.
- **`merge` reuses the `review` tool's archive transition per source**, one source at a
  time: target's `tags` become the union across target + all sources, `importance`
  becomes the max across the same set, then each source is archived individually
  (`sqlite.archiveMemory` + `storage.deleteMemory`) and audited `ARCHIVE` with
  `action: 'consolidate'` and `merged_into: target_id` in `LifecycleAuditDetails`. If
  one source's archive/delete fails partway through, the already-archived sources stay
  archived and the failed ones stay live; the tool returns `{ merged: [...], failed:
  [...] }` rather than attempting a cross-store transaction that the codebase has no
  primitive for (`writeMemory`/`deleteMemory` are already individually
  best-effort-with-rollback at the single-memory level, not batch-atomic — see
  `StorageManager.deleteMemories`, `src/storage/index.ts:302-340`, which has the same
  partial-failure shape for the same reason). A retried `merge` on the same
  `source_ids` is safe: already-archived sources are skipped (detected via
  `getArchiveByMemoryId`, the same check `review`'s `archive` action uses to
  distinguish "already archived" from "never existed").
- **`merged_from` is broadened from a single id to a comma-joined list of source ids**
  when a merge has more than one source, appended to any prior value rather than
  overwritten (a memory can be the target of more than one consolidation over its
  life). This is a convention change, not a schema change: the column is untyped `TEXT`
  (`src/storage/sqlite.ts:192`) and no code path in the repo does an exact-match lookup
  against it (verified by grep — every reference either sets it, reads it opaquely into
  `MemoryRecord.merged_from`, or defaults it to `null`).
- **No new content re-embedding on merge.** The target's vector is untouched — its
  content doesn't change, only its `tags`/`importance`/`merged_from` metadata does, so
  `storage.updateMemory` is called without a `newVector`, and the Qdrant payload update
  that entails still keeps the row's existing `embedding_model` stamp.

## Risks / Trade-offs

- **Cost/bounding**: a true pairwise scan across a large store is `O(n²)` and was
  explicitly rejected for that reason. The chosen per-point ANN approach is `O(n ·
  top_k)` Qdrant queries per `list` call, itself capped by `max_scan_per_call` +
  pagination, so a single tool call's cost is bounded independent of store size — the
  trade-off is that a full-namespace consolidation pass needs multiple `list` calls
  (client-driven pagination) rather than one. This mirrors the same trade-off
  `review list` already makes for the due-queue, so it is not a new UX pattern.
- **ANN is approximate, not exact.** `findNeighborsById` can miss a true near-duplicate
  HNSW's graph doesn't surface at the requested `top_k`, or (rarely) return a
  false-below-threshold score. This is the same approximation `searchSimilar` already
  accepts for write-time dedup (`src/pipeline/index.ts:139-143`) — consolidation is not
  introducing a new class of imprecision, just applying the existing one retroactively.
  Operators who need exhaustive coverage can lower `similarity_threshold` and/or raise
  `neighbor_top_k` at the cost of more false-candidate clusters to review.
- **Partial-merge failures** leave a cluster half-consolidated (some sources archived,
  some not) if a mid-loop Qdrant/SQLite error occurs. Mitigated by per-source isolation
  (one failure doesn't abort the rest), an idempotent retry (already-archived sources
  are skipped, not double-processed), and a response shape (`merged`/`failed`) that
  makes partial completion visible rather than silently reporting success.
- **`merged_from` semantic broadening** (single id → optionally comma-joined list) is a
  soft compatibility risk if a future change starts treating the field as a strict
  single-FK reference. Documented in code and in the spec so a future author sees the
  convention before assuming single-value semantics.
- **False-positive clusters at the 0.9 default** are possible (0.9 is below the tier
  UPDATE thresholds of 0.95/0.9 in `dedupThresholdFor`, chosen deliberately to surface
  candidates dedup itself would not have auto-merged, not just ones it would have) —
  mitigated entirely by the human-approval gate: `list` only ever suggests, `merge`
  only ever acts on an explicit, named `target_id`/`source_ids` pair.
