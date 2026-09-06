## Context

`extractiveSummary(content, maxLen = 120)` (`src/domain/summarize.ts:41-77`) is a
four-stage pipeline:

1. split `content` into sentences — `.split(/[.!?\n]+/)`, trim, drop empties
   (`src/domain/summarize.ts:45-48`)
2. short-circuit: zero sentences → `''`; exactly one → `truncate(sentence, maxLen)`
   (`src/domain/summarize.ts:50-53`)
3. score each sentence by `sum(tf(token)) / sqrt(tokenCount)` over a document-wide
   term-frequency map, stopwords excluded (`src/domain/summarize.ts:55-75`)
4. return `truncate(best.text, maxLen)` (`src/domain/summarize.ts:76`)

Only stage 1 is wrong. Stages 2-4 behave correctly given a correct sentence list —
which is what makes this a genuinely one-line fix rather than a rewrite of the
summarizer. The scorer is not choosing badly; it is choosing the best of four shards
that should never have been four things.

`extractiveSummary` is reached only through `summarizeContent`
(`src/domain/summarize.ts:101-125`), which routes `auto_summarize: false` to
`generateSummary` and an enabled-and-healthy LLM provider to `provider.summarize`,
falling through to `extractiveSummary` otherwise. That is the default path — no config,
no credentials — so this defect is what most deployments actually get.

Three call sites reach `summarizeContent`, all already `async`, none of which need to
change: `src/pipeline/index.ts:241` (main write path, run concurrently with `embed`),
`src/pipeline/index.ts:575` (`deterministicFallback`, the embeddingless degraded
write), and `src/storage/index.ts:268` (`revertMemory`).

Note the blast radius beyond display: `memories_fts` is an FTS5 table over
`(content, summary, tags)` and `fullTextSearch` weights `summary` matches 2× against
`content`. A shard summary does not merely fail to help ranking — it doubles the weight
of whatever tokens happen to fall inside the shard. In the observed case that promoted
`limo` and dropped `specialagentk` entirely from the double-weighted field.

## Goals / Non-Goals

Goals:

- Stop intra-token punctuation — the dots in URLs, domains, semantic versions, and
  filenames — from being read as sentence boundaries.
- Leave output byte-identical for every input that summarises correctly today. This
  fix must not be a behavioural rewrite wearing a bug-fix label; a proposal that
  silently reflows every existing summary is far harder to review and to trust.
- Keep the change auditable: one regex, no signature changes, no new dependency, no
  config surface.

Non-Goals:

- **No full sentence-segmentation library.** Correct sentence boundary detection
  (abbreviations, honorifics, decimals, ellipses, quotations) is a genuinely hard NLP
  problem and every serious solution is a dependency. `improve-memory-summarization`
  chose "dependency-free, small hardcoded stopword list" deliberately; this change
  keeps that constraint rather than reopening it to fix a defect.
- **No abbreviation handling.** `e.g. foo` still mis-splits, improving only from
  `["e", "g", "foo"]` to `["e.g", "foo"]`. Correcting it needs an abbreviation
  lexicon, which is the dependency this change declines to add. Called out explicitly
  so a reviewer does not read the new regex as claiming to solve segmentation.
- **No retroactive re-summarization.** Memories already holding a shard summary keep
  it. Backfilling means rewriting `memories.summary` and the matching `memories_fts`
  row per memory, under the same delete-then-reinsert pattern
  `src/storage/sqlite.ts` uses on update — a separate change with its own migration
  and rollback story.
- **No change to the scoring formula, tokenizer, stopword list, `maxLen`, or the
  `...` truncation convention.**

## Decisions

### Decision: lookahead on whitespace, not a URL pattern

The obvious alternative is to detect URLs specifically — extract them, or mask them
before splitting and restore after. Rejected: it fixes one shape of the bug. Semantic
versions (`v1.34.4`), filenames (`summarize.ts`), bare domains without a scheme
(`specialagentk.eth.limo`), and IP addresses are all the same defect and none of them
are URLs. A URL-aware regex would also have to be maintained against scheme and TLD
drift.

The chosen rule — a boundary is `.`/`!`/`?` **followed by whitespace or end-of-input** —
is a property of sentence punctuation itself, not of any token type. In well-formed
prose a terminal period is always followed by a space or the end of the string; inside
a compound token it never is. One rule, no token taxonomy to maintain.

```ts
// before (src/domain/summarize.ts:46)
.split(/[.!?\n]+/)

// after
.split(/[.!?]+(?=\s|$)|\n+/)
```

The alternation preserves newline splitting unconditionally: `\n` remains a boundary
regardless of what follows it, so `"Meeting notes:\nWe decided..."` still yields two
sentences. Without the separate `\n+` branch, a newline would only split when followed
by more whitespace.

`$` without the `m` flag anchors to end-of-input, which is what is wanted — a trailing
`"Ends with a period."` splits into `["Ends with a period", ""]` and the existing
`.filter(s => s.length > 0)` (`src/domain/summarize.ts:48`) drops the empty tail, as it
already does today.

### Decision: verify the no-op claim empirically, not by inspection

The proposal's central risk is the "identical for correct input" claim. Both regexes
were run over a case matrix covering the broken shapes and the previously-correct ones
before this proposal was written:

| Input | Current | Proposed |
|---|---|---|
| `...https://specialagentk.eth.limo (ENS domain served via eth.limo)` | 4 shards | 1 sentence, whole |
| `Deploy runbook. Restart the pod, then verify https://api.example.com/health returns 200.` | 4 shards | 2 sentences, correct |
| `Bumped to v1.34.4. The regression was in src/domain/summarize.ts line 46.` | 5 shards | 2 sentences, correct |
| `Meeting notes:\nWe decided to move the vector store...` | 2 sentences | 2 sentences (identical) |
| `One single sentence with no punctuation at all` | 1 | 1 (identical) |
| `Ends with a period.` | 1 | 1 (identical) |
| `Multiple!! Punctuation?? Marks.` | 3 | 3 (identical) |
| `Uses e.g. an abbreviation mid-sentence. Second sentence here.` | `["Uses e","g","an abbreviation...","Second..."]` | `["Uses e.g","an abbreviation...","Second..."]` |

Every previously-correct row is unchanged; every changed row is one the current
splitter got wrong. Task 2.4 pins this matrix into the test suite so the claim stays
true.

## Risks / Trade-offs

- **Run-on punctuation without a following space** (`"Done.Next thing"`) stops
  splitting where it used to. This is a real behaviour change, in the direction of
  under-splitting rather than over-splitting: the result is one longer sentence
  truncated to `maxLen`, not a meaningless shard. Given the field is a 120-char
  human-scannable label, an over-long-but-whole sentence is the better failure.
- **Longer selected sentences** mean `truncate` fires more often, so some summaries
  gain the trailing `...`. Acceptable — the truncation convention is unchanged and the
  120-char invariant still holds.
- **Regression surface is small but the file is hot**: `summarize.ts` is on every write
  path. Mitigated by the change being confined to one expression with no signature or
  control-flow change, and by task 3.2 running the full suite rather than only the new
  cases.
