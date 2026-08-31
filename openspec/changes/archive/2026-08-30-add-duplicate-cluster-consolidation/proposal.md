## Why

Dedup only fires at write time, and only against the incoming candidate: the write
pipeline embeds the new content, fetches the top-10 similar existing memories in the
same namespace/collection/tier, and classifies ADD/UPDATE/DELETE against `similar[0]`
(`src/pipeline/index.ts:139-143`, `classifyOperation` at `src/pipeline/index.ts:291`).
Nothing ever looks *backward* across the memories already stored. Two write paths
routinely accumulate near-duplicates that this check never sees:

- **Imports** (`import` tool, `src/tools/import.ts`) write many memories from one
  document in one pass; two sections that restate the same fact land as two separate
  memories because neither was "the incoming candidate" when the other was written.
- **Degraded-window writes**: when the embedding provider is down, the pipeline falls
  back to a checksum/Jaccard heuristic (`src/pipeline/index.ts:353-377`) that is looser
  than cosine similarity, and once the provider recovers nothing reconciles what was
  written during the outage against what already existed.

Over the life of a long-lived store these near-dupes only ever grow — there is no
mechanism, automatic or manual, that ever looks at the existing corpus and asks "which
of these already say the same thing." `composite-recall-ranking` and
`push-down-recall-filters` improve how existing memories are scored and filtered, but
neither reduces how many near-identical memories are competing for those slots in the
first place.

## What Changes

- Add a `consolidate` MCP tool with two actions:
  - `list` — scans a namespace/collection for clusters of near-duplicate memories
    (pairwise similarity ≥ a configurable threshold, default 0.9) and returns them with
    a suggested merge target per cluster. Bounded and paginated per call (see
    design.md) — never a full unbounded pairwise scan.
  - `merge` — merges one or more source memories into an explicitly named target
    memory: unions tags, raises importance to the max across the cluster, archives each
    source through the existing archive transition (vector removed, row moved to
    `archived_memories`), and records the merge lineage on the target's `merged_from`
    field. **Always requires an explicit human-supplied `target_id` and `source_ids`**
    — there is no automatic or scheduled merge path.
- Add a `consolidation` config block (Zod schema + defaults) for the similarity
  threshold, per-point neighbor breadth, and the per-call scan cap.
- Extend `LifecycleAuditDetails.action` with a `'consolidate'` variant and an optional
  `merged_into` field so merge-driven archives are distinguishable in the audit log from
  ordinary GC/`review` archives.
- Register schema/handler; update `CLAUDE.md`'s canonical tool list, README ×5, bump
  `package.json` version.

## Capabilities

### New Capabilities
- `duplicate-cluster-consolidation`: existing near-duplicate memories can be discovered
  in bounded, paginated clusters and merged into one canonical memory through an
  explicit, human-approved action — closing the read-side gap write-time dedup leaves
  open for imports and degraded-window accumulation.

### Modified Capabilities

## Impact

- Affected code: `src/tools/schemas.ts` (new tool schema), `src/tools/index.ts` (new
  handler, reusing the `review` tool's archive-transition code path), `src/domain/schemas.ts`
  (input validation), `src/domain/types.ts` (`LifecycleAuditDetails` extension),
  `src/config/index.ts` (new `consolidation` block), `src/storage/qdrant.ts` (new
  per-point neighbor query, see design.md), tests.
- MCP surface grows by one tool → `CLAUDE.md` canonical list + README ×5 sync required
  in the same change (repo rule; see `add-review-and-archive-recall` for the precedent).
- No schema migrations: `merged_from` is an existing untyped `TEXT` column
  (`src/storage/sqlite.ts:192`) whose single-id convention is broadened to a
  comma-joined list only when a merge has more than one source — no other code path
  reads it as anything but an opaque string (verified: no exact-match queries against
  it in the codebase).
- Reuses the archive transition `add-review-and-archive-recall` introduced for its
  `review` tool's `archive` action (`src/tools/index.ts:356-392`) rather than
  duplicating vector-delete/row-archive logic.
- Explicitly **not** built here, but named as the reason this is worth doing now: the
  clustering machinery (`list`'s neighbor-graph construction) is the natural substrate
  for episodic→semantic distillation ("sleep", brainstorm item 3.2 /
  `add-memory-distillation`, not yet proposed) — that change would consume the same
  cluster shape to produce a *synthesized* memory instead of a human-picked target. This
  proposal does not attempt distillation, content synthesis, or type conversion.
- Depends on nothing; can land independently of `add-composite-recall-ranking` or
  `push-down-recall-filters`, though it complements both by shrinking the candidate set
  they rank/filter over.
