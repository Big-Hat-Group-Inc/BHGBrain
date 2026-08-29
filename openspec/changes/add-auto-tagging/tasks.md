## 1. Config schema

- [x] 1.1 Add `pipeline.auto_tag_enabled` (`z.boolean().default(true)`) and
  `pipeline.auto_tag_max_per_memory` (`z.number().int().min(0).max(20).default(6)`)
  to the Zod `pipeline` object in `src/config/index.ts:211-216`, alongside the
  existing `extraction_enabled`/`fallback_to_threshold_dedup` fields.
- [x] 1.2 Add both fields, with comments, to the sample config block in `README.md`
  (`pipeline` object around `README.md:492-501`) — same section that already documents
  `extraction_enabled`.

## 2. Deterministic tag extractor

- [x] 2.1 Create `src/domain/auto-tag.ts` exporting
  `extractAutoTags(content: string, maxTags: number): string[]`, following the
  regex-pattern-list style of `SECRET_PATTERNS`/`INVALIDATION_PATTERNS` in
  `src/domain/normalize.ts:21-27,40-50`.
- [x] 2.2 Implement the five match patterns from `design.md` Decisions, in priority
  order: inline-code spans, camelCase/PascalCase/snake_case/dotted identifiers
  (5-char floor), file paths (slash+extension, plus a bare-filename allowlist),
  repo shorthand (`owner/repo`, excluding recognized file-path extensions), and
  `@mentions` (excluding email-shaped tokens via negative lookbehind).
- [x] 2.3 Implement the slugifier (`@` → `at-` prefix, lowercase, collapse
  non-`[a-z0-9]` runs to `-`, trim leading/trailing `-`, truncate to 100 chars, drop
  results shorter than 2 chars) so every emitted tag satisfies
  `TagSchema` (`src/domain/schemas.ts:4,14`) unmodified.
- [x] 2.4 Deduplicate post-slug preserving first-seen priority order, then truncate
  to `maxTags`.
- [x] 2.5 Unit tests in `src/domain/auto-tag.test.ts`: one case per pattern category
  (including at least one true negative per category — a token that must *not*
  match, e.g. an email address for the mention pattern, a version string like
  `v1.2.3` for the dotted-identifier pattern), a slugification table test, a
  dedup/ordering test, and a `maxTags` truncation test.

## 3. Pipeline wiring

- [x] 3.1 In `WritePipeline.extract()` (`src/pipeline/index.ts:61-80`), when
  `config.pipeline.auto_tag_enabled` is true, call `extractAutoTags(normalized,
  config.pipeline.auto_tag_max_per_memory)` and union the result with `input.tags`
  via `[...new Set([...input.tags, ...autoTags])]` (caller tags first), then slice
  to `TagsSchema`'s 20-tag cap (`src/domain/schemas.ts:15`) before assigning
  `candidate.tags`. Implemented as a `deriveTags()` helper, called per-candidate
  (both the pass-through path and the multi-candidate `raw.map()` path) so tags are
  derived from each candidate's own content, matching the spec's "content of every
  candidate" requirement.
- [x] 3.2 When `auto_tag_enabled` is false, `extract()`'s candidate is byte-identical
  to today's pass-through (no behavior change on the kill switch).
- [x] 3.3 Confirm (add a regression test if not already covered) that `handleImport`
  (`src/tools/import.ts`) picks up auto-tagging for free by routing through
  `ctx.pipeline.process()` — no separate wiring needed there.
- [x] 3.4 Pipeline tests in `src/pipeline/index.test.ts`: ADD with no caller tags
  gains auto-tags from content; ADD with caller tags gets caller tags ∪ auto-tags;
  UPDATE unions auto-tags into `mergedTags` same as any candidate tag
  (`src/pipeline/index.ts:170`); combined array never exceeds 20 and caller tags are
  never evicted by the trim; `auto_tag_enabled: false` reproduces current
  pass-through output exactly (candidate tags identical to `input.tags`).

## 4. Downstream verification (no code change expected)

- [x] 4.1 Confirm `SqliteStore.fullTextSearch`'s tag weighting
  (`src/storage/sqlite.ts:786-789`) and `recall`/`search`'s `tags` filter push-down
  (`RecallFilter`, `src/domain/types.ts:18-25`) require no changes — auto-tags are
  ordinary `tags` array entries and exercise those paths unmodified. Add an
  integration-style test if one doesn't already cover "recall filtered by an
  auto-derived tag returns the memory" to make this explicit.

## 5. Docs

- [x] 5.1 Document the auto-tagging behavior in `README.md`: extend the `tags` rows
  in the tool-reference tables (Memory Model, `remember`, `recall`) to note tags may
  include content-derived entries, and add a new "Auto-Tagging" subsection right
  after Deduplication describing the four extraction categories, the slugification
  rule, and the two config knobs. (Original task line refs `README.md:908`/`2306`/
  `1163` were stale against the current file, which has grown well past those
  offsets since the proposal was written; located the actual sections by content
  match instead.)
- [x] 5.2 Mirror the same doc changes into `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md`.
- [x] 5.3 Bump `package.json` `version` (was `1.26.0`, not the stale `1.11.0` the
  proposal referenced — many other changes landed since this proposal was written;
  bumped to `1.27.0`).

## 6. Validation

- [x] 6.1 `npm run lint` (tsc --noEmit + eslint, `@typescript-eslint/no-explicit-any`
  as error — the extractor must be fully typed, no `any`). Clean, zero errors.
- [x] 6.2 `npm test` — full suite green, including new `auto-tag.test.ts` and updated
  `pipeline/index.test.ts` cases. 849/849 passed on a clean rerun (one pre-existing
  timing flake in `src/transport/http.test.ts` — "returns health without auth" —
  timed out under full-suite parallel load on the first run, passed both in
  isolation and on a full-suite rerun; unrelated to this change, `src/transport/`
  untouched here).
- [x] 6.3 Manual spot-check, done as an automated integration test rather than a
  live MCP round-trip (no Docker/Qdrant provisioned in this sandbox — see notes):
  `src/storage/sqlite.test.ts`'s new "fullTextSearch tags filter matches an
  auto-derived tag" test derives tags from real content via `extractAutoTags`
  (file path + camelCase identifier, no caller-supplied tags), inserts the memory
  into a real `SqliteStore`, and confirms `fullTextSearch(..., { tags: [...] })`
  filtered by one derived tag returns exactly that memory. `src/tools/import.test.ts`
  and `src/pipeline/index.test.ts` separately confirm the stored `tags` array
  end-to-end through a real `WritePipeline` for content containing a file path,
  repo shorthand, `@mention`, and camelCase identifier.
