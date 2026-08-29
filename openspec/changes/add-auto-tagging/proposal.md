## Why

Tags are caller-supplied and most writes carry none — the write path never derives a
tag from content. That leaves two mechanisms effectively dead:

- The `tags` filter on `recall`/`search` (`RecallInputSchema.tags`,
  `src/domain/schemas.ts:43`; pushed down via `RecallFilter`,
  `src/domain/types.ts:18-25`) has nothing to filter on for the common case of an
  untagged memory.
- Fulltext scoring weights a `tags` match **2×**, the same as a summary match
  (`SqliteStore.fullTextSearch`, `src/storage/sqlite.ts:786-789`:
  `countOccurrences(tags, term) * 2`) — a boost that never fires when `tags` is `[]`.

Meanwhile the content people actually write is full of implicit tag-shaped signal:
file paths (`src/pipeline/index.ts`), repo shorthand (`bhgbrain/core`), `@mentions`,
and code identifiers (`extractionEnabled`, `MAX_RETRIES`) — all present in the
normalized content string that already flows through
`WritePipeline.extract()` (`src/pipeline/index.ts:61-80`) and is discarded as tag
signal today. `extract()`'s own comment already reserves this stage for
"future...extraction"; this proposal fills the deterministic slice of that gap.

## What Changes

- Add a deterministic, dependency-free tag extractor
  (`src/domain/auto-tag.ts`, new file) that scans normalized content for four
  token shapes and emits normalized tag strings:
  1. **Code-shaped tokens** — markdown inline-code spans and
     camelCase/PascalCase/snake_case/dotted identifiers (e.g. `` `useEffect` ``,
     `extractionEnabled`, `search.ranking.enabled`).
  2. **File paths** — slash-separated paths with a recognized extension, or bare
     dotted filenames (`README.md`, `package.json`).
  3. **Repo shorthand** — `owner/repo`-shaped two-segment slash tokens that are not
     file paths.
  4. **@-mentions** — `@handle`-shaped tokens, excluding email addresses.
- Every extracted token is slugified to satisfy the existing `TagSchema` pattern
  (`^[a-zA-Z0-9-]+$`, `src/domain/schemas.ts:4,14`) unchanged — no widening of tag
  validation, no new punctuation class. `@handle` becomes `at-handle` so the mention
  shape survives slugification instead of colliding with a plain word tag.
- Wire extraction into `WritePipeline.extract()` (`src/pipeline/index.ts:61-80`):
  auto-derived tags are unioned with caller-supplied tags (caller tags always win
  ties and are never dropped), deduplicated, and the combined array is capped at the
  existing 20-tag limit (`TagsSchema.max(20)`, `src/domain/schemas.ts:15`),
  preferring caller-supplied tags when trimming.
- Add `pipeline.auto_tag_enabled` (default `true`) and
  `pipeline.auto_tag_max_per_memory` (default `6`) to the Zod config schema
  (`src/config/index.ts:211-216`), following the existing `pipeline.*` flat-field
  convention. Disabling the flag restores today's pass-through behavior exactly.
- No schema or storage changes: extracted tags are stored as ordinary `tags` entries
  — same column, same fulltext weighting, same filter path. `import` and `remember`
  both route through `WritePipeline.process()`, so both benefit without separate
  wiring.
- Document the extractor's rules and config knobs in `README.md` and the four
  translations; bump `package.json` version.

## Capabilities

### New Capabilities
- `auto-tagging`: Writes are automatically tagged from content-derived, deterministic
  signal (code tokens, file paths, repo shorthand, @-mentions) in addition to any
  caller-supplied tags, making the existing tag filter and fulltext tag-weight useful
  on untagged input.

### Modified Capabilities

## Impact

- Affected code: `src/domain/auto-tag.ts` (new), `src/pipeline/index.ts` (`extract`),
  `src/config/index.ts` (`pipeline.auto_tag_*`), co-located tests.
- Behavior: writes that previously stored `tags: []` now typically store a small set
  of content-derived tags; writes with caller-supplied tags gain additional tags
  unless `auto_tag_enabled` is `false`. `tags` filtering on `recall`/`search` becomes
  materially more useful; fulltext tag-weighted scoring now fires on untagged input.
  No change to write *classification* (ADD/UPDATE/DELETE/NOOP) — auto-tagging runs
  inside `extract()`, before dedup classification, and does not influence it.
- Docs: README ×5, `.env.example` unchanged (no new env vars — two new
  `pipeline.*` config fields only), version bump.
- Non-goals / future work: LLM-based entity extraction into a normalized `entities`
  table (brainstorm item 2.3 "v2") is explicitly out of scope — see `design.md`
  Non-Goals. Its payoff (single-hop "everything about `<entity>`" queries and graph
  edges) additionally depends on a `memory_links` table proposed separately
  (brainstorm item 3.1, not yet an OpenSpec change) and is left for a future
  `add-entity-extraction` proposal.
- Depends on: nothing. Composes with `add-composite-recall-ranking` (tags feed the
  same fulltext relevance the composite prior multiplies) but does not require it.
