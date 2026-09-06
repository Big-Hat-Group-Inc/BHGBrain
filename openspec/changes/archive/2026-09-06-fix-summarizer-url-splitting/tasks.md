## 1. Fix the sentence splitter

- [x] 1.1 In `src/domain/summarize.ts:46`, replace `.split(/[.!?\n]+/)` with
  `.split(/[.!?]+(?=\s|$)|\n+/)`. The alternation is required: the `\n+` branch keeps
  newlines splitting unconditionally, while the `[.!?]+` branch only fires when the
  punctuation run is followed by whitespace or end-of-input. Leave the surrounding
  `.map(s => s.trim())` / `.filter(s => s.length > 0)` chain
  (`src/domain/summarize.ts:47-48`) exactly as-is — it already drops the empty tail
  produced by content ending in a period.
- [x] 1.2 Update the `extractiveSummary` doc comment
  (`src/domain/summarize.ts:33-40`), which currently describes splitting content "into
  sentences" without qualification. State the boundary rule (terminal punctuation
  followed by whitespace or end-of-input, or a newline) and why: intra-token dots in
  URLs, domains, versions, and filenames are not sentence boundaries. Reference this
  change id so the constraint is not "simplified" back out later.
- [x] 1.3 Confirm no other call site re-implements sentence splitting: grep for
  `[.!?]` and `split(` across `src/domain/` and `src/pipeline/`. `tokenize`
  (`src/domain/summarize.ts:26-31`) splits on `/\W+/` for term-frequency counting only
  and is deliberately out of scope — word tokenization is not sentence segmentation,
  and changing it would alter the scorer.

## 2. Regression tests

- [x] 2.1 In `src/domain/summarize.test.ts`, add the observed production case:
  `extractiveSummary("Special Agent K's website is https://specialagentk.eth.limo (ENS domain served via eth.limo)")`
  SHALL return the whole sentence, not the shard `"limo (ENS domain served via eth"`.
- [x] 2.2 Add cases for the other intra-token shapes: a semantic version
  (`"Bumped to v1.34.4. The regression was in src/domain/summarize.ts line 46."` → two
  sentences, neither severing `v1.34.4` or `summarize.ts`) and a URL mid-prose
  (`"Deploy runbook. Restart the pod, then verify https://api.example.com/health returns 200."`
  → two sentences with the URL intact).
- [x] 2.3 Assert the sentence-final case still splits: `"First sentence. Second sentence."`
  yields two sentences, and content ending in a period yields no trailing empty
  sentence.
- [x] 2.4 Pin the no-op claim from design.md: add cases asserting byte-identical output
  for multi-line content (`"Meeting notes:\nWe decided..."`), single-sentence content,
  content with no terminal punctuation, empty/whitespace-only content, and repeated
  punctuation (`"Multiple!! Punctuation?? Marks."`). These are the rows that must not
  move; without them the "identical for correct input" claim is unverified.
- [x] 2.5 Add an explicit test documenting the accepted limitation from design.md's
  Non-Goals: `"Uses e.g. an abbreviation mid-sentence. Second sentence here."` still
  mis-splits at `e.g.`, improving to `["Uses e.g", ...]` rather than `["Uses e", "g", ...]`.
  Asserting the known-imperfect output keeps a later reader from mistaking it for an
  unnoticed bug.
- [x] 2.6 Add one `summarizeContent` test proving the tiering is untouched:
  `auto_summarize: false` with URL-bearing content still routes to `generateSummary`
  (literal first-line truncation, URL intact because that path never splits at all).

## 3. Validation

- [x] 3.1 `npm run lint` (`tsc --noEmit` + `eslint src`) passes.
- [x] 3.2 `npm test` passes in full — not just `summarize.test.ts`. `src/pipeline/
  index.test.ts` and `src/storage/index.test.ts` build fixtures whose expected
  summaries come from this code path; if any fixture asserts a shard summary as its
  expected value, that assertion was encoding the bug and should be corrected to the
  whole sentence, with the correction noted in the task list rather than made silently.
- [x] 3.3 Verify against a live server rather than only unit tests: write a memory
  containing a URL through the MCP `remember` tool and confirm the persisted `summary`
  holds the whole sentence. `bhgbrain show <id>` prints the stored value.
- [x] 3.4 `npm version patch` (never hand-edit `package.json`, per CLAUDE.md's
  Versioning note, so `package-lock.json`'s root version cannot drift).

## 4. Tracking

- [ ] 4.1 Create the mirroring Linear issue in the `bhgbrain` project on the
  `BigHatGroup` team, titled `fix-summarizer-url-splitting: <summary>`, and set it to
  In Progress before the first edit (CLAUDE.md, "Every proposal is mirrored by a Linear
  issue"). This proposal was authored without Linear access, so the issue does not
  exist yet — it must be created before implementation starts, not after.
- [ ] 4.2 On completion, run `/opsx:archive` and set the issue to Done. The `openspec`
  CLI (`@fission-ai/openspec`) is now installed, so `openspec archive
  fix-summarizer-url-splitting` is available rather than moving the directory by hand.
- [ ] 4.3 **Spec baseline caveat** — this repo has no promoted specs:
  `openspec list --specs` reports "No specs found" and `openspec/specs/` does not
  exist, because all ~40 archived changes were archived without promoting their spec
  deltas. That is why this change's delta is `## ADDED Requirements` rather than
  `## MODIFIED`, even though it corrects existing behaviour — `openspec change
  validate --strict` reports that archive would refuse a MODIFIED delta against a
  target spec that does not exist. If a baseline is established before this change
  archives (see 5.2), convert the delta to MODIFIED and re-validate first.

## 5. Follow-up (not in this change)

- [ ] 5.1 Existing memories keep their shard summaries — this change only affects
  writes from here forward. If the backlog matters, open a separate change for
  re-summarization: it must rewrite `memories.summary` and the matching `memories_fts`
  row in one transaction (delete-then-reinsert, mirroring the update path in
  `src/storage/sqlite.ts`), or fulltext search desynchronises from the stored summary.
- [ ] 5.2 The missing spec baseline is a repo-wide condition, not specific to this
  change: ~40 changes archived without promoting specs, so OpenSpec has no accumulated
  requirements to validate future deltas against and every change is forced to file
  ADDED. Worth its own change to decide whether to backfill `openspec/specs/` from the
  archive or accept change-local specs as the convention.
