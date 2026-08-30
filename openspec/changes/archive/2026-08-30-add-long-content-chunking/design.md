## Context

`remember` and `import` share one write pipeline (`WritePipeline.process`,
`src/pipeline/index.ts:29-59`) but take content through it very differently:

- `remember` (`handleRemember`, `src/tools/index.ts:133-154`) passes `input.content`
  straight through to `ctx.pipeline.process` as a single candidate. `extract()`
  (`src/pipeline/index.ts:61-80`) is explicitly documented as "single-candidate only";
  `decide()` embeds that one candidate once (`src/pipeline/index.ts:121`) and runs it
  through the ADD/UPDATE/DELETE/NOOP classifier (`classifyOperation`,
  `src/pipeline/index.ts:291-314`).
- `import` (`handleImport` → `processMemories`, `src/tools/import.ts:36-144`) never
  calls the pipeline with raw document text. `ProfileParser` first splits the document
  into many small `ParsedMemory` candidates — `parseProfile` by `## N.` heading plus
  `splitByParagraphs` (`src/pipeline/parser.ts:34-68`, `:135-147`), or `parseFreeform`
  by heading/paragraph boundaries via `splitFreeform`
  (`src/pipeline/parser.ts:74-90`, `:116-133`) — and then calls
  `ctx.pipeline.process` once per chunk in a loop (`src/tools/import.ts:110-131`).
  Each chunk gets its own embedding and its own dedup decision; none of this required
  any change to `WritePipeline` itself.

`import`'s max content size (500,000 chars, `src/tools/import.ts:9`) is safe precisely
*because* nothing that large is ever embedded as a single vector. `remember`'s cap
(100,000 chars, `src/tools/schemas.ts:8`) offers no equivalent protection — the entire
string is embedded as-is.

## Goals / Non-Goals

Goals:
- Stop `remember` from silently producing multi-page mush-vector memories.
- Point the caller at the tool that already handles this (`import`,
  `format: "freeform"`) rather than reimplementing chunking a second time.
- Zero changes to `WritePipeline`'s dedup/decision logic, storage schema, or search/
  recall path.

Non-Goals:
- Automatic chunking inside `remember` itself.
- A `parent_id` / chunk-family model for recall (see Decisions below for why this was
  considered and rejected for this change).
- Smarter content-aware splitting than `ProfileParser` already does — that is a
  separate, `import`-scoped improvement if ever needed.

## Decisions

- **Reject-and-suggest-import, not chunk-at-write.** The brainstorm item framed this as
  a choice between (a) `remember` chunking long content itself, embedding each chunk
  under a shared `parent_id`, or (b) `remember` rejecting content past a threshold and
  pointing at `import`. This proposal picks **(b)**.

  Chunking inside `remember` (option a) would require:
  - A multi-candidate `extract()` — today explicitly single-candidate
    (`src/pipeline/index.ts:61-73`), with a `TODO` noting multi-candidate extraction is
    out of scope until a future change.
  - A `parent_id` field threaded through `MemoryRecord` (`src/domain/types.ts:37-60`),
    SQLite schema/migrations, and the Qdrant payload.
  - A recall-time decision for chunk families: does `recall` return every matching
    chunk individually (duplicate near-identical results from the same source
    document), the parent's full content when any chunk matches (requires
    reassembling and re-summarizing at read time, and picking one score to report),
    or a deduplicated "best chunk per parent" (requires grouping logic in
    `buildSearchResults`, which `add-composite-recall-ranking` just finished tuning)?
  - Dedup semantics for a *second* long `remember` call with overlapping content:
    chunk-level dedup against an existing parent's chunks, or whole-document dedup
    against the parent — either needs new comparison logic `classifyOperation`
    (`src/pipeline/index.ts:291-314`) doesn't have today.

  None of that is required for option (b). `import` already has multi-candidate
  splitting, already loops single-candidate `pipeline.process` calls per chunk, and
  already returns per-chunk results with no `parent_id` concept — chunks are stored as
  fully independent memories, and that has been the working behavior of `import` all
  along. Rejecting past a threshold reuses 100% of that existing, tested path and adds
  zero surface area to the write pipeline, storage layer, or search/recall path. Given
  the guidance to prefer whichever option reuses more code and touches
  dedup/decision logic less, (b) is the only one that touches neither.

- **Guard location: the `remember` tool handler, not `WritePipeline.process`.** Three
  call sites reach the pipeline: `remember` (`src/tools/index.ts:138`), `import`
  (`src/tools/import.ts:111`), and `bootstrap` (`src/tools/bootstrap.ts:109`). Only
  `remember` passes raw, unchunked caller content — `import` and `bootstrap` already
  pass pre-split, typically-small candidates. Putting the length guard inside
  `WritePipeline.process` would risk rejecting a legitimately long *unsplit* section
  from `import`/`bootstrap` (e.g., a profile section with no paragraph breaks) with a
  message telling the caller to use `import`, which is nonsensical when the caller
  *is* `import`. Putting the guard in `handleRemember` instead scopes it to exactly the
  one call site that needs it.

- **Threshold default: 8,000 characters (~2,000 tokens, roughly 1–2 pages).** Chosen as
  comfortably above normal single-fact/decision/runbook memories (the existing README
  examples for `remember` are all well under 1,000 chars) and comfortably below the
  point where embedding quality is known to degrade for typical embedding models
  (retrieval fidelity drops noticeably past roughly a page of undifferentiated text).
  Configurable via `pipeline.long_content_threshold_chars` so operators storing
  naturally longer atomic content (e.g., full runbooks) can raise it without a code
  change, and validated `> 0` and `<= 100000` (the `remember` schema's own ceiling —
  a threshold above that can never trigger) in the Zod schema.

- **Rejection, not silent truncation or best-effort chunking.** Silent truncation loses
  data without telling the caller. Best-effort auto-chunking inside `remember` is
  exactly option (a), rejected above. A hard rejection with an actionable message is
  the only option that is both correct and cheap.

## Risks / Trade-offs

- **Breaking change for existing long-`remember` callers.** Any caller currently
  pasting large documents into `remember` and getting a (poor-quality but successful)
  ADD will now get an error. This is the intended effect — those writes were already
  low-value — but it must be called out in the README as behavior-changing, not framed
  as purely additive.
- **Threshold is a blunt instrument.** A 7,999-character block of dense, topically
  mixed text embeds just as poorly as an 8,001-character one; length is a proxy for
  "probably multi-topic," not a precise measure. Accepted because the alternative
  (content-aware splitting heuristics inside `remember`) is exactly the complexity this
  proposal avoids by delegating to `import`.
- **Two tools, two size ceilings, now two purposes.** Callers must understand
  `remember` is for atomic facts and `import` is for documents. The rejection message
  and README cross-reference carry this weight; if the message is unclear, callers hit
  a wall with no obvious next step. Mitigated by making the error message name the
  exact fix (`import`, `format: "freeform"`).
