## 1. Config schema

- [x] 1.1 Add `long_content_threshold_chars` to the `pipeline` block in the Zod config
  schema (`src/config/index.ts:211-216`): `z.number().int().positive().max(100000)`,
  default `8000`. Keep it alongside the existing `extraction_enabled`,
  `extraction_model`, `extraction_model_env`, `fallback_to_threshold_dedup` fields in
  the same `.default({})` object so an absent `pipeline` block in `config.json` still
  resolves to the new default.
- [x] 1.2 Confirm no `.env.example` change is needed (no new env var — this is a
  `config.json`-only field, consistent with how `search.ranking` was handled in
  `add-composite-recall-ranking/tasks.md:1.2`) and no `AGENTS.md` change is needed
  (its "Config vs. environment" section doesn't enumerate individual `pipeline.*`
  fields either).

## 2. Remember-path guard

- [x] 2.1 In `handleRemember` (`src/tools/index.ts:133-154`), after
  `parseInput(RememberInputSchema, args)` and before calling `ctx.pipeline.process`,
  compare `input.content.length` against
  `ctx.config.pipeline.long_content_threshold_chars`. When the content exceeds the
  threshold, throw `invalidInput(...)` (imported at `src/tools/index.ts:19`) with a
  message stating the actual character count, the configured threshold, and the fix:
  call `import` with `format: "freeform"` (or split the content into smaller
  `remember` calls). No embedding call, no pipeline invocation, no memory written.
- [x] 2.2 Do not add this guard to `WritePipeline.process`
  (`src/pipeline/index.ts:29-59`) — leave the pipeline's dedup/decision logic and its
  other two call sites (`src/tools/import.ts:111`, `src/tools/bootstrap.ts:109`)
  untouched, per `design.md`'s "Guard location" decision.
- [x] 2.3 Content at exactly the threshold is accepted (only content strictly greater
  than the threshold is rejected) — match the boundary behavior other size limits in
  this codebase use (e.g. `ContentSchema`'s `.max(100000)` accepts exactly 100000).

## 3. Tests

- [x] 3.1 `src/tools/index.test.ts`: `remember` with content over the default 8,000
  threshold throws `INVALID_INPUT` (`BrainError` with `code: 'INVALID_INPUT'`) and the
  message mentions `import`; no `ctx.pipeline.process` call occurs (assert the mock
  pipeline was not invoked).
- [x] 3.2 `src/tools/index.test.ts`: `remember` with content exactly at the threshold,
  and with content comfortably under it, succeeds unchanged (existing remember tests
  continue to pass — this is a regression guard for the boundary).
- [x] 3.3 `src/tools/index.test.ts`: a custom `pipeline.long_content_threshold_chars`
  in the test config (e.g. lowered to 100) is honored — confirms the handler reads
  from config rather than a hardcoded constant.
- [x] 3.4 `src/config/index.test.ts`: `pipeline.long_content_threshold_chars` defaults
  to `8000` when omitted from `config.json`; rejects `0`, negative, non-integer, and
  values above `100000`.
- [x] 3.5 Confirm `import` and `bootstrap` tests are unaffected — no new failures in
  `src/tools/import.test.ts` / `src/tools/bootstrap.test.ts` from this change (the
  guard is not present on their call paths).

## 4. Docs

- [x] 4.1 `README.md` § `remember` (around line 2294-2310): add a row or note for the
  new threshold behavior — content over `pipeline.long_content_threshold_chars`
  (default 8,000 chars) is rejected with guidance to use `import`
  (`format: "freeform"`) instead of the 100,000-char hard cap being the only limit
  callers see.
- [x] 4.2 `README.md` § `import` (around line 2656-2687): add a short cross-reference
  note ("if `remember` rejected your content as too long, use `import` with
  `format: "freeform"` here") so the two tools' docs point at each other.
- [ ] 4.3 Mirror both README changes into `README.de.md`, `README.es.md`,
  `README.fr.md`, `README.zh-CN.md`, section-for-section. PARTIAL: the `remember`
  threshold note was mirrored into all four translated READMEs' `### remember`
  sections. The `import` cross-reference note could **not** be mirrored: none of the
  four translated READMEs contain an `import` (or `bootstrap`) tool section at all —
  that's a pre-existing translation gap (confirmed via
  `grep -n "^### \`" README.*.md`, which shows `remember` through `repair` in English
  but only up through `backup`/`revisions`/`review`/`repair` in the translations, with
  `bootstrap` and `import` missing entirely) that predates this change and is out of
  this proposal's scope to backfill (it would mean authoring four new translated tool
  sections from scratch, not mirroring an edit). Left unchecked rather than
  papering over the gap.
- [x] 4.4 Bump `package.json` `version` (currently `1.15.0`, was `1.11.0` when this
  task was written) to `1.16.0` — this is a user-visible, behavior-changing addition
  (existing long `remember` calls that used to succeed now fail).

## 5. Validation

- [x] 5.1 `npm run lint` (tsc --noEmit + eslint, no `any` casts).
- [x] 5.2 `npm test` — full suite green, including the new tests from section 3.
