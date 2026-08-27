## Why

`recall` fetches `limit` results and only then discards those failing its filters
(`src/tools/index.ts:150-169`): `min_score` first, then `type`, then `tags`. The stores
never see the filters, so a call like `recall(query, type: "procedural", limit: 5)` can
legitimately return **zero** results even when matching procedural memories exist just
below the semantic top-5 — the five slots were spent on non-matching types before the
filter ran. The same starvation applies to `tags`.

Separately, the score being thresholded is mode-dependent in a way the schema hides:
`min_score` (default 0.6, `src/tools/schemas.ts:34`) reads as a cosine-similarity
threshold and is only coherent because `handleRecall` hardcodes semantic mode. Hybrid
RRF scores live in a completely different range (max ≈ `weights/(RRF_K+1)` ≈ 0.03), so
any future change that points recall at hybrid mode silently filters out every result.

## What Changes

- Push `type` and `tags` filters down into the stores so `limit` applies to *matching*
  memories: Qdrant payload filters on the semantic path (the payload already carries
  `type` and `tags`), and SQL predicates on the fulltext path.
- Keep post-retrieval filtering only as a defensive re-check, not the primary mechanism.
- Make score semantics explicit and safe: document that `min_score` is a cosine
  threshold applied to `semantic_score`, apply it to that field (not the fused/adjusted
  `score`), and add a guard test that would fail if recall's mode changed without
  recalibrating the threshold.
- Add a `recall_zero_after_filter` counter metric so filter starvation (the current
  symptom) becomes observable if any residual path still post-filters.
- Update the `recall`/`search` tool documentation in `README.md` (§ MCP Tools Reference)
  and the four translated READMEs; bump `package.json` version.

## Capabilities

### New Capabilities
- `recall-filter-pushdown`: Recall filters (type, tags) are applied inside the storage
  layer so result limits count matching memories, and score thresholds are applied to
  the score field whose range they were calibrated for.

### Modified Capabilities

## Impact

- Affected code: `src/tools/index.ts` (`handleRecall`), `src/storage/qdrant.ts`
  (`search` gains an optional payload filter), `src/storage/sqlite.ts`
  (`fullTextSearch` gains type/tags predicates), `src/search/index.ts` (filter
  plumbing), plus co-located tests.
- Behavior: filtered recalls return up to `limit` matching results instead of
  whatever survives post-filtering; unfiltered calls are unchanged.
- Docs: README ×5, `.env.example` untouched (no new env), version bump.
