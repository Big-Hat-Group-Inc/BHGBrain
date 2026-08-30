## Context

BHGBrain stores memories via a write pipeline that normalizes content, generates embeddings, deduplicates via checksum, and persists to SQLite + Qdrant. The existing `bhgbrain.remember` tool handles single memories. The bootstrap prompt produces a 12-section profile document with headings like `## 1. Core Identity`, `## 2. Goals & Priorities`, etc., each mapping to a specific collection, tier, type, and importance range.

Users who already have a completed profile document (or arbitrary notes) currently need to manually call `remember` once per memory — there is no batch ingestion path.

## Goals / Non-Goals

**Goals:**
- Accept a full 12-section bootstrap profile and atomically split it into discrete memories with correct metadata
- Accept freeform text and chunk it into memories using paragraph/heading-based splitting
- Provide a dry-run mode for previewing what would be stored
- Reuse the existing `WritePipeline` for each memory (dedup, embedding, storage)
- Return a structured summary of results

**Non-Goals:**
- Real-time streaming progress (batch completes, then returns summary)
- Supporting file uploads or binary attachments — input is text only
- Replacing the interactive bootstrap prompt — this is a complementary path
- Building a general-purpose ETL framework

## Decisions

### 1. Section parser as a standalone module in `src/pipeline/`

**Decision:** Create `src/pipeline/parser.ts` with a `ProfileParser` class that splits profile text by `## N.` headings and maps each section to its metadata (collection, tier, type, importance, tags) using a static mapping table.

**Rationale:** Keeps parsing logic isolated and testable. The mapping table mirrors the bootstrap prompt's storage mapping, making it a single source of truth. Alternative: regex-only inline parsing in the tool handler — rejected because it mixes concerns and is harder to test.

### 2. Freeform mode uses heading/paragraph splitting, not LLM extraction

**Decision:** For `format: "freeform"`, split on markdown headings (`##`, `###`) and double-newline paragraph boundaries. Each chunk becomes a separate memory with `type: "semantic"` and `tier: T2` defaults.

**Rationale:** Keeps the feature dependency-free and deterministic. LLM-based extraction would require an additional API key (`BHGBRAIN_EXTRACTION_API_KEY`) and adds latency/cost. If LLM extraction is desired later, it can be added as a `format: "extracted"` mode.

### 3. Sequential pipeline processing with batch summary

**Decision:** Process each parsed memory sequentially through `WritePipeline.process()`, collecting results. Return a single summary object at the end.

**Rationale:** The write pipeline already handles embedding, dedup, and storage. Sequential processing avoids overwhelming the embedding API rate limits. Parallelism can be added later with concurrency controls if needed.

### 4. MCP tool registration alongside existing tools

**Decision:** Register `bhgbrain.import` in `src/index.ts` next to the existing tool definitions. The tool handler validates input, delegates to the parser, then iterates through the pipeline.

**Rationale:** Follows the established pattern for `remember`, `recall`, etc. No new transport or routing infrastructure needed.

## Risks / Trade-offs

- **Large profiles may be slow** (12 sections × multiple memories × embedding calls) → Mitigation: Sequential processing keeps it predictable; users can use `dry_run` to preview first. Future: add concurrency.
- **Section mapping drift** — If the bootstrap prompt sections change, the parser mapping must be updated → Mitigation: Keep mapping table as a clearly labeled constant; document it.
- **Freeform chunking quality** — Heading/paragraph splitting may produce overly granular or overly coarse chunks → Mitigation: Reasonable defaults; users can review with `dry_run` and adjust input.
