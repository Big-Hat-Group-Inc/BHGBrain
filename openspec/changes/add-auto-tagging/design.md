## Context

`WritePipeline.extract()` (`src/pipeline/index.ts:61-80`) is a single choke point for
both `remember` and `import` (`handleImport` also calls `ctx.pipeline.process(...)`,
which calls `extract()` internally) — one place to add extraction reaches both entry
points. Today it is a pass-through:

```ts
return [{
  content: normalized,
  type: input.type,
  tags: input.tags,
  importance: input.importance,
}];
```

Its own comment already flags this as the future extraction stage ("TODO...implement
LLM-backed multi-candidate extraction"), but reserves that TODO for candidate
*splitting*, not tagging. Tag derivation is a separate, additive concern: it doesn't
change candidate count, so it composes cleanly with that future work rather than
competing with it.

Tags are validated by `TagSchema` (`src/domain/schemas.ts:4,14`):
`z.string().max(100).regex(/^[a-zA-Z0-9-]+$/)`, inside `TagsSchema` (`.max(20)` array
length). This regex is duplicated verbatim in the MCP tool JSON-Schema
(`src/tools/schemas.ts:11`). Both stay untouched — auto-derived tokens are normalized
to satisfy the existing pattern rather than widening it.

The 2× tag weight already exists and is unconditional
(`src/storage/sqlite.ts:786-789`); the `tags` recall/search filter is pushed down
(`push-down-recall-filters`, `RecallFilter` in `src/domain/types.ts:18-25`). Neither
needs to change — auto-tagging just gives them something to act on.

## Goals / Non-Goals

Goals:
- Deterministic, dependency-free (no LLM call, no network) tag extraction from
  normalized write content.
- Four token shapes: code identifiers/inline-code, file paths, repo shorthand,
  @-mentions.
- Every emitted tag satisfies `TagSchema` unmodified.
- Caller-supplied tags are never dropped or reordered-below an auto tag when the
  merged set must be trimmed to the 20-tag cap.
- Config kill switch (`pipeline.auto_tag_enabled: false`) restores exact current
  behavior.

Non-Goals:
- **LLM-based entity extraction into a normalized `entities` table** (brainstorm item
  2.3 "v2": people/projects/tools with dedicated schema, enabling "everything about
  `<entity>`" queries). That is a materially larger change — new storage schema, a
  model dependency and its failure modes, normalization/entity-resolution logic — and
  is left for a future `add-entity-extraction` proposal. Its full payoff (graph edges
  between memories) also depends on a `memory_links` table
  (brainstorm item 3.1, "Typed edges between memories"), which does not exist yet as
  an OpenSpec change; that dependency is noted here so the future proposal doesn't
  have to rediscover it.
- No change to `TagSchema`'s validation pattern, to `TagsSchema`'s 20-tag cap, or to
  the JSON-Schema copy in `src/tools/schemas.ts`.
- No change to fulltext scoring weights, dedup/UPDATE tag-merge logic beyond feeding
  it a larger `candidate.tags` array, or to write classification (ADD/UPDATE/
  DELETE/NOOP unaffected — extraction runs before `classifyOperation`).
- No per-tag provenance tracking (marking a tag as "auto" vs "caller-supplied" in
  storage). `tag`'s existing add/remove tool already lets a caller correct any tag
  regardless of origin; a provenance field is deferred until a concrete need for it
  (e.g. selective auto-tag re-run) appears.
- No stopword list, TF-IDF, or corpus-aware scoring — v1 is per-memory, content-local
  pattern matching only, consistent with the "deterministic v1" framing in the
  brainstorm.

## Decisions

- **New module, not inline in the pipeline**: `src/domain/auto-tag.ts` exports
  `extractAutoTags(content: string, maxTags: number): string[]`, alongside the
  existing deterministic-heuristic modules in `src/domain/` (`normalize.ts`'s
  `SECRET_PATTERNS`/`INVALIDATION_PATTERNS` are the direct precedent for
  regex-list-of-patterns-as-policy in this codebase). Keeps `pipeline/index.ts`'s
  `extract()` a thin caller and makes the extractor independently unit-testable.
- **Extraction patterns** (applied in this priority order, each producing a
  slugified candidate token):
  1. *Inline code spans*: `` `([^`\n]{2,80})` `` — markdown backtick spans are the
     strongest signal a token is a deliberate identifier, not prose.
  2. *Identifier-shaped bare words*: camelCase (`\b[a-z]+[A-Z][a-zA-Z0-9]*\b`),
     PascalCase (`\b[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*\b`), SCREAMING_SNAKE_CASE /
     snake_case (`\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b`), and dotted config
     paths (`\b[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){1,3}\b`, e.g.
     `search.ranking.enabled`) — each with a minimum length floor (5 chars) to cut
     noise from short accidental matches (`eBay`, `iOS`-style two-token words).
  3. *File paths*: `\b[\w.-]*\/[\w./-]*\.[A-Za-z0-9]{1,10}\b` (slash-containing,
     extension-terminated) plus a closed set of bare dotted filenames matched
     without a slash requirement (`package.json`, `tsconfig.json`, `README.md`,
     `Dockerfile`, `.env.example`, ...) so a path mentioned without its directory
     still tags.
  4. *Repo shorthand*: exactly one `/`, two non-empty segments each
     `[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?`, and **not** already matched as a
     file path (no recognized extension on the trailing segment) — e.g.
     `bhgbrain/core`, `qdrant/qdrant`.
  5. *@-mentions*: `(?<![\w.@])@[a-zA-Z0-9_-]{2,39}\b` — the negative lookbehind
     excludes `user@domain.com` (email) and `foo@bar` mid-identifier cases.
  Patterns run independently over the same content (not mutually exclusive passes);
  a token can only be claimed by one category by construction (e.g. a file path with
  a slash won't also match repo-shorthand because repo-shorthand's extension
  exclusion rules it out).
- **Slugify, don't widen validation**: each raw match is lowercased, `@` mapped to
  `at-` (preserving the mention marker through slugification instead of losing it),
  every run of non-`[a-z0-9]` characters collapsed to a single `-`, leading/trailing
  `-` trimmed, and the result truncated to 100 chars (`TagSchema.max(100)`). Matches
  that slugify to fewer than 2 characters are dropped. This means, e.g.,
  `src/pipeline/index.ts` → `src-pipeline-index-ts`, `@jsmith` → `at-jsmith`,
  `bhgbrain/core` → `bhgbrain-core`, `` `useEffect` `` → `useeffect`.
- **Ordering and caps**: within `extractAutoTags`, candidates are deduplicated
  (post-slug) preserving first-seen order across the priority list above, then
  truncated to `maxTags` (config `pipeline.auto_tag_max_per_memory`, default 6) —
  giving code/path/repo/mention signal priority over volume. In
  `WritePipeline.extract()`, the auto-tag result is unioned with caller-supplied
  `input.tags` via `[...new Set([...input.tags, ...autoTags])]` (caller tags listed
  first so a subsequent trim-to-20 keeps them), then the combined array is sliced to
  `TagsSchema`'s 20-tag cap.
- **Runs once per candidate, before dedup classification**: extraction happens in
  `extract()`, which today builds the single v1 candidate before `decide()` computes
  the checksum and runs similarity search. Auto-tags are therefore part of
  `candidate.tags` by the time `classifyOperation` runs, but derived purely from
  content — they do not feed the checksum (computed from raw content only) or the
  embedding, so they cannot change ADD/UPDATE/DELETE/NOOP classification themselves.
  On UPDATE, they flow into the existing `mergedTags` union
  (`src/pipeline/index.ts:170`) exactly like any other candidate tag.
- **Config, not a hardcoded constant**: `pipeline.auto_tag_enabled` and
  `pipeline.auto_tag_max_per_memory` join the existing `pipeline.*` block
  (`src/config/index.ts:211-216`) rather than a new top-level block, matching how
  `extraction_enabled`/`fallback_to_threshold_dedup` are already scoped there.
  `auto_tag_enabled: false` makes `extract()` behave exactly as it does today
  (byte-identical candidate).

## Risks / Trade-offs

- **False positives**: camelCase/PascalCase heuristics will occasionally flag
  ordinary capitalized prose fragments or brand names as code tokens (e.g. "McDonald"
  is not PascalCase-shaped by this regex, but a two-word compound like "GitHub" is,
  and will legitimately tag as `github` — arguably still useful signal, but not
  necessarily "code"). Mitigated by the length floor, the `enabled` kill switch, and
  the tag `remove` action for outliers; not eliminated. Accepted as inherent to a
  pattern-based v1, called out in the requirement scenarios below as a known
  imprecision rather than a bug.
- **False negatives**: prose that describes code concepts in plain English gets no
  tags; this proposal only helps when writers already use code-shaped tokens or
  paths, which is common in this codebase's own memory content (dev-tool usage) but
  not universal.
- **Tag budget contention**: on content already near the 20-tag cap from caller input
  plus prior UPDATE-merge accumulation, auto-tags may be entirely crowded out. This is
  the intended trim priority (caller tags win) but means auto-tagging's benefit
  degrades exactly on the busiest, most-tagged memories — acceptable since those
  already have caller-supplied tag signal to filter on.
- **Regex maintenance surface**: five pattern categories is more surface than the
  existing two-list `normalize.ts` precedent. Kept in one file with one exported
  function and a table-driven test (task 3.x) to bound the maintenance cost.
