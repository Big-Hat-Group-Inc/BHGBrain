## Why

`remember`'s content field accepts up to 100,000 characters
(`src/tools/schemas.ts:8`, `ContentSchema` in `src/domain/schemas.ts:16`) and the write
pipeline embeds every candidate as exactly one vector — `extract()` is deliberately
"single-candidate only" (`src/pipeline/index.ts:61-80`) and `decide()` calls
`this.embedding.embed(candidate.content)` once per call (`src/pipeline/index.ts:121`).
A caller who pastes a full document into `remember` gets one embedding for the whole
thing. Embeddings of multi-thousand-word text collapse toward the corpus centroid —
they match many unrelated queries weakly instead of any one query strongly — so a
100k-char memory is nearly useless for recall even though it stores and dedups
successfully.

The `import` tool already solves exactly this problem for bulk documents:
`ProfileParser.parseFreeform` (`src/pipeline/parser.ts:74-90`) splits arbitrary
markdown by heading and paragraph boundaries via `splitFreeform`
(`src/pipeline/parser.ts:116-133`), and `processMemories`
(`src/tools/import.ts:101-144`) feeds each chunk through the normal
`ctx.pipeline.process` decision path — one embedding per chunk, full dedup, no
special-casing. `import` accepts up to 500,000 characters
(`src/tools/import.ts:9`) precisely because it never embeds the whole document as one
vector. `remember` has no equivalent path: a caller who wants chunked storage today
must already know to call `import` with `format: "freeform"` instead — nothing in
`remember` tells them that, so the mush-vector failure mode is silent.

## What Changes

- `remember` gains a configurable content-length guard. Content at or under
  `pipeline.long_content_threshold_chars` (new config, default 8,000 characters ≈ 1–2
  pages) is stored exactly as it is today — no behavior change for the overwhelming
  majority of calls.
- Content over the threshold is **rejected** with an `INVALID_INPUT` error whose
  message names the char count, the threshold, and the fix: call `import` with
  `format: "freeform"` (or split the content and call `remember` per chunk). No memory
  is written, no embedding call is made.
- The guard lives in the `remember` tool handler (`handleRemember`,
  `src/tools/index.ts:133-154`), not in `WritePipeline.process`
  (`src/pipeline/index.ts:29-59`) — `import` and `bootstrap` also call
  `ctx.pipeline.process` (`src/tools/import.ts:111`, `src/tools/bootstrap.ts:109`) with
  already-chunked candidates that must not be re-rejected by the same guard.
- No schema, storage, or search changes: chunks created via `import` remain
  independent memories exactly as they are today (no `parent_id`, no chunk-family
  recall semantics to design or maintain).

## Capabilities

### New Capabilities
- `long-content-chunking`: `remember` enforces a configurable content-length ceiling
  and, past it, rejects the write with actionable guidance to use `import`'s existing
  chunking path instead of silently storing a low-quality mush-vector memory.

### Modified Capabilities

## Impact

- Affected code: `src/tools/index.ts` (`handleRemember` guard), `src/config/index.ts`
  (new `pipeline.long_content_threshold_chars` schema field), co-located tests.
- Not affected: `src/pipeline/index.ts` (dedup/decision logic untouched),
  `src/pipeline/parser.ts` (reused as-is), `src/tools/import.ts` (reused as-is), no
  Qdrant/SQLite schema change.
- Behavior: `remember` calls with content ≤ threshold are unchanged. Calls above
  threshold that previously succeeded (storing a single low-quality mega-embedding) now
  fail fast with a message pointing at `import`. This is a breaking change for any
  caller relying on `remember` to silently accept arbitrarily long content — flagged in
  the README as a behavior change, not just a new field.
- Docs: README.md ×5 (`remember` table + a note under `import` cross-referencing it),
  `.env.example` unchanged (no new env var), version bump.
- Depends on: nothing. Deliberately orthogonal to `add-composite-recall-ranking` and
  `push-down-recall-filters` — this changes what gets written, not how it is ranked or
  filtered.
