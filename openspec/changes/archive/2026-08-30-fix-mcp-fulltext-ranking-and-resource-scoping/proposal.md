## Why

A code audit of the completed `add-mcp-contract-and-inject` change (plus one item carried over from `address-codereview-issues`) surfaced net-new correctness and security defects in the MCP interface layer that drift from the contracts the project already committed to:

- **Fulltext ranking is fake.** `fullTextSearch` assigns every matching row the identical constant rank (`-terms.length`), so fulltext mode does not actually rank by lexical relevance and the hybrid RRF fulltext component degenerates to insertion order. This violates the "fulltext mode returns lexical-ranked results" scenario and silently degrades hybrid result quality.
- **Resource reads leak across namespaces.** The `collection://` and `category://` resources ignore the caller's namespace scope (`collection://{name}` hardcodes `'global'`; `collection://list` and `category://` carry no namespace dimension), contradicting the namespace-visibility requirement. Namespaces are the isolation boundary, so this is a cross-namespace data-exposure (confidentiality) issue in multi-client/multi-project deployments.
- **Hybrid search hides dependency outages.** When the embedding provider is unavailable, hybrid search silently swallows the error and degrades to fulltext-only with no log, no metric, and no client-visible signal — unlike semantic mode, which raises `EMBEDDING_UNAVAILABLE`. A degraded result is indistinguishable from a healthy one, undermining troubleshooting and result repeatability.
- **MCP structured content is not delivered structurally.** Tool results return their payload as `JSON.stringify(...)` inside a `text` content block rather than the MCP `structuredContent` field, so clients that consume structured content still have to re-parse plain text.

## What Changes

- Replace the constant fulltext rank with a real per-row lexical relevance score (e.g. SQLite FTS `bm25`/`rank` or term-frequency scoring), order fulltext results by it, and feed that ordering into hybrid RRF so the fulltext component reflects true relevance.
- Make `collection://` and `category://` resources honor the caller's namespace scope: default to `config.defaults.namespace`, honor an explicit `?namespace=`, and pass it through to the underlying storage queries (`listCollections`, the collection-scoped read, and category lookups). Define and document whether categories are intentionally global.
- Make hybrid search surface embedding outages instead of swallowing them: emit a `warn`-level log (and/or metric) on degradation and signal partiality to the caller (e.g. a `degraded` indicator), so a fulltext-only fallback is observable rather than silent.
- Deliver successful, object-shaped tool results via the MCP `structuredContent` field on `CallToolResult` (retaining the text block for backward compatibility).
- Add per-tool contract tests asserting `INVALID_INPUT` rejection for unknown fields and out-of-bounds values on `recall`, `search`, `tag`, `category`, and `backup` (completing the partial original task 3.3).

## Capabilities

### Modified Capabilities
- `hybrid-search-ranking`: Fulltext mode SHALL rank by real lexical relevance; hybrid mode SHALL surface (not silently swallow) embedding outages.
- `memory-resources`: `collection://` and `category://` resource reads SHALL honor namespace scoping.
- `mcp-tool-contract`: Successful object-shaped tool results SHALL be delivered via the MCP `structuredContent` field.

## Impact

- Affects the SQLite fulltext query and scoring (`src/storage/sqlite.ts`), the search fusion path (`src/search/index.ts`), the resource handlers (`src/resources/index.ts`), and the MCP `CallTool` response shaping (`src/index.ts`).
- Tightens a confidentiality boundary; resource reads that previously returned cross-namespace data will now be namespace-scoped (a behavior change clients relying on the leak would notice).
- Changes fulltext and hybrid result ordering (now relevance-ranked); existing tests that assumed constant ranking may need updates.
- Requires new contract tests for per-tool validation rejection and tests asserting the new ranking, namespace scoping, degraded-hybrid signal, and `structuredContent` delivery.
