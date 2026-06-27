## Context

The `add-mcp-contract-and-inject` change shipped the MCP tool/resource/search contracts and was audited as largely complete (`codeaudit/add-mcp-contract-and-inject-2026-06-05-02-19.md`: 0 Critical, 0 High, 4 Medium, 4 Low). The audit found two material spec drifts (fulltext ranking is a constant; resource namespace scoping is not enforced for collection/category) and one observability gap (hybrid silently swallows embedding outages). A related audit of `address-codereview-issues` found that MCP "structured content" is delivered as JSON-in-a-text-block rather than via the MCP `structuredContent` field. This change fixes those net-new findings without redesigning the contracts already in place.

Relevant code:
- `src/storage/sqlite.ts:552-581` — `fullTextSearch`, which selects `${terms.length} as rank` and pushes `rank: -terms.length` for every row, using non-sargable `LOWER(...) LIKE '%term%'` predicates.
- `src/search/index.ts:88-171` — `fulltextSearch` and `hybridSearch`; the latter swallows embedding failure at `:125-127`.
- `src/resources/index.ts:201-238` — `handleCategory` and `handleCollection`; the collection handler hardcodes `'global'` at `:234`.
- `src/index.ts:104-114` — `CallTool` handler returning `JSON.stringify(result)` in a text block.

## Goals / Non-Goals

**Goals**
- Make fulltext mode rank by real lexical relevance and feed that into hybrid RRF.
- Enforce namespace scoping on `collection://` and `category://` resource reads (close the cross-namespace leak).
- Make hybrid embedding degradation observable (log/metric + caller-visible signal).
- Deliver successful tool results via the MCP `structuredContent` field.
- Complete the per-tool validation contract tests left partial in the original task 3.3.

**Non-Goals**
- Redesigning the RRF fusion algorithm, weights, or the tool/resource URI scheme.
- The Low-severity audit items not central to correctness/security: shared URI-parser extraction, `recall.min_score` JSON-schema drift, and `collection://{name}` pagination beyond what namespace scoping requires (may be addressed opportunistically but are not in scope here).
- Migrating `memories_fts` to a full FTS5 virtual table if the sql.js build does not support it; a deterministic term-frequency fallback is acceptable.

## Decisions

1. **Fulltext relevance via FTS5 `bm25`/`rank`, with a term-frequency fallback.** Prefer `bm25(memories_fts)` (or `rank`) with `MATCH` if the sql.js build exposes FTS5, which also removes the non-sargable `LIKE` scan. If FTS5 is unavailable, compute a deterministic per-row score from term frequency / matched-field counts so distinct rows get distinct, relevance-ordered ranks. Either way, results are ordered by descending relevance and the search layer normalizes consistently.
2. **Resources default to `config.defaults.namespace` and honor `?namespace=`.** `collection://list`/`{name}` and `category://list`/`{name}` resolve the namespace the same way `memory://` already does, then pass it through to storage. This makes the default read namespace-scoped and a cross-namespace read an explicit, opt-in request.
3. **Categories: explicit scoping decision required.** Categories currently have no namespace dimension. We will either add namespace scoping to category storage/reads or explicitly document categories as a global, intentionally cross-namespace concept and encode that in the spec scenario, so the behavior is no longer ambiguous.
4. **Hybrid degradation is logged and signaled, not swallowed.** Replace the empty `catch` with a `warn` log (`{ event: 'embedding_degraded', degraded: 'fulltext_only', err }`) and surface a `degraded` indicator on the hybrid response. We keep graceful degradation (a hard error would be a worse experience than fulltext-only) but make it observable, matching the project intent that dependency outages are not silent.
5. **`structuredContent` added alongside the text block.** Successful, object-shaped results get `structuredContent: result` on the `CallToolResult`; the existing pretty-printed text block stays for backward compatibility. Error envelopes continue to set `isError: true`.

## Risks / Trade-offs

- **Behavior change for clients relying on the namespace leak.** Any client that depended on `collection://`/`category://` returning all-namespace data will see fewer results by default. Mitigation: explicit `?namespace=` remains available; documented in the spec/README.
- **Result-ordering change.** Fulltext and hybrid orderings change from insertion order to relevance order. Existing tests asserting the old constant ranking must be updated; this is expected and desirable.
- **FTS5 availability uncertainty.** The sql.js build may not include FTS5. Mitigation: deterministic term-frequency fallback (Decision 1) keeps the requirement satisfiable regardless.
- **`structuredContent` client compatibility.** Some clients may not read `structuredContent`. Mitigation: the text block is retained, so no client loses access to the payload.

## Migration Plan

- No data migration. All changes are read-path / response-shaping. Existing memories, vectors, and config are untouched.
- The `memories_fts` table is already populated; if moving to FTS5 `MATCH`, ensure the table is (or is rebuilt as) FTS5-compatible at startup; otherwise the term-frequency fallback operates on the existing table.
- Roll out is a single code release; no phased migration required. Clients gain `structuredContent` and observable degradation transparently; the namespace-scoping change is the only client-visible behavior shift and is documented.

## Open Questions

- Are categories intended to be global (cross-namespace) or namespace-scoped? Decision 3 must be resolved before implementing task 2.3; the spec scenario will encode whichever is chosen.
- Should the hybrid `degraded` signal be a top-level response field, a per-result flag, or only a log/metric? Task 3.2 assumes a caller-visible indicator; confirm the exact shape during implementation.
- Does the pinned sql.js build expose FTS5 (`bm25`/`MATCH`)? Determines whether Decision 1 uses FTS5 or the term-frequency fallback.
