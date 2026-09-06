## Why

`extractiveSummary` (`src/domain/summarize.ts:41-77`) splits content into sentences on

```ts
.split(/[.!?\n]+/)
```

(`src/domain/summarize.ts:46`). That regex treats **every** `.` as a sentence
boundary, including the dots inside URLs, domain names, semantic versions, and
filenames. The TF scorer then ranks the resulting shards and returns whichever one
scores highest — frequently a meaningless fragment from the middle of a URL.

This is not theoretical. A memory written with content
`Special Agent K's website is https://specialagentk.eth.limo (ENS domain served via eth.limo)`
was persisted with the summary:

```
limo (ENS domain served via eth
```

The splitter produced `["Special Agent K's website is https://specialagentk", "eth",
"limo (ENS domain served via eth", "limo)"]` and the scorer picked shard 3. Observed
against the current build on real data, not a constructed test case.

The failure generalises to any content a memory server is likely to hold:

| Content | Current shards |
|---|---|
| `...verify https://api.example.com/health returns 200.` | `"...verify https://api"`, `"example"`, `"com/health returns 200"` |
| `Bumped to v1.34.4. The regression was in src/domain/summarize.ts line 46.` | `"Bumped to v1"`, `"34"`, `"4"`, `"The regression was in src/domain/summarize"`, `"ts line 46"` |
| `Uses e.g. an abbreviation mid-sentence.` | `"Uses e"`, `"g"`, `"an abbreviation mid-sentence"` |

The damage is not confined to display. `improve-memory-summarization`'s own Why
section establishes that `summary` is load-bearing in three places, and every one of
them degrades when the field holds a URL shard:

- **Fulltext ranking** — `fullTextSearch` ranks with
  `bm25(memories_fts, 1.0, 2.0, 2.0)` (`src/storage/sqlite.ts:1255`), i.e. `summary`
  and `tags` weighted **2×** against `content`. (Note this is the current FTS5/BM25
  path, not the legacy `LIKE` term-frequency scorer that
  `improve-memory-summarization`'s Why section described — `upgrade-fulltext-to-fts5`
  has since landed, and `memories_fts` is a real FTS5 virtual table.) A summary of
  `limo (ENS domain served via eth` puts double weight on the token `limo` and none on
  `specialagentk`, actively mis-ranking the memory rather than merely failing to help
  it.
- **`memory://list` / `memory://{id}` browsing** — `.summary` is the human-scannable
  label (`src/tools/index.ts`, `src/cli/index.ts`).
- **Session inject fallback** — `ResourceHandler` prints `mem.summary` when content
  does not fit the budget, exactly the case where a shard is least useful.

There is no configuration escape. `auto_summarize: false` avoids the splitter, but
only by reverting to literal first-line truncation for *every* memory, and the
per-write tiering has no per-memory override. Rewording content does not help either:
because the dots are inside the URL itself, every phrasing tested still severed the
domain (`"Special Agent K website: https://specialagentk.eth.limo"` →
`"Special Agent K website: https://specialagentk"`). The only way to get a correct
summary for URL-bearing content today is to edit the `summary` column directly, which
also desynchronises `memories_fts` unless the FTS row is rewritten in the same
transaction.

## What Changes

- Change the sentence-boundary regex in `extractiveSummary` from `/[.!?\n]+/` to a
  form that only treats `.`/`!`/`?` as a boundary when it is **followed by whitespace
  or end-of-input**, while still always splitting on newlines:
  `/[.!?]+(?=\s|$)|\n+/`. Dots with a non-space character on their right — the dots in
  `eth.limo`, `v1.34.4`, `summarize.ts`, `api.example.com` — stop being boundaries.
- No change to tokenization, the term-frequency scorer, tie-breaking, `maxLen`
  truncation, the `...` convention, or any function signature. The fix is confined to
  how the sentence list is produced; everything downstream of it is untouched.
- Add regression tests covering URL-, version-, and path-bearing content, and assert
  the existing multi-sentence, multi-line, single-sentence, and empty-content
  behaviours are unchanged.

## Capabilities

### New Capabilities
- `memory-summarization`: The extractive tier's sentence segmentation SHALL NOT treat
  intra-token punctuation (URLs, domains, versions, filenames) as a sentence boundary,
  so summaries of content containing such tokens carry a whole sentence rather than a
  shard of one.

  Filed as an **ADDED** delta rather than MODIFIED, despite fixing existing behaviour.
  This repo has no promoted spec baseline — `openspec list --specs` reports none, and
  `openspec/specs/` does not exist, because the ~40 archived changes were archived
  without their specs being promoted. `openspec change validate --strict` refuses a
  MODIFIED delta against a non-existent target spec ("only ADDED requirements are
  allowed for new specs"), so the spec file restates the `memory-summarization`
  requirement in full, with segmentation corrected, rather than expressing a diff
  against a baseline that isn't there. See the note in tasks.md §4.

### Modified Capabilities

## Impact

- Affected code: `src/domain/summarize.ts:46` (the split regex, one line) and
  `src/domain/summarize.test.ts` (new regression cases). Nothing else in `src/`
  changes — `summarizeContent`'s tiering, `generateSummary`'s literal-truncation path
  (`src/domain/normalize.ts`), the write pipeline (`src/pipeline/index.ts:241`,
  `src/pipeline/index.ts:575`), and `revertMemory` (`src/storage/index.ts:268`) all
  call through unchanged signatures.
- Behavior: summaries change **only** for content where a `.`, `!`, or `?` is
  immediately followed by a non-whitespace character — i.e. exactly the currently
  broken cases. Prose that already summarised correctly produces byte-identical output,
  because in well-formed prose every terminal `.` is followed by a space or the end of
  the string. Verified across the existing case matrix before writing this proposal.
- Data: **existing** summaries are not rewritten. This changes summarization at write
  time only; memories already persisted with a shard summary keep it until they are
  next written or reverted. Re-summarizing the backlog is deliberately out of scope
  (see design.md, Non-Goals) and would need its own change with an FTS-resync story,
  since `memories_fts` indexes `summary` alongside `content` and `tags`.
- Config: none. No new fields, no default changes, `auto_summarize` semantics
  untouched.
- Docs: none required — no user-facing config or documented behaviour changes. The
  README's `auto_summarize` description remains accurate.
- Version: patch bump via `npm version patch` (behavioural fix, no API or config
  surface change).
- Depends on: `improve-memory-summarization` (archived, landed) — this fixes a defect
  in the extractive tier that change introduced.
