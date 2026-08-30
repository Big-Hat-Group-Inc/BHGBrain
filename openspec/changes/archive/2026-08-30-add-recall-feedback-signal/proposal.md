## Why

Every `recall`/`search` response carries scores and ordering the store computed, but
nothing ever tells the store whether those scores were *right*. Two other proposals
just landed that make this gap concrete:

- `add-composite-recall-ranking` weights results by `importance`, `access_count`, and
  tier-aware decay (`src/search/index.ts`, `buildSearchResults`) — but its own Non-Goals
  say plainly: "No learned weights or feedback loop (a future `recall-feedback`
  change)." The weights (`w_imp: 0.3`, `w_acc: 0.2`, `access_norm: 50`) and per-tier
  `λ` in `search.ranking` (`src/config/index.ts`) are defaults chosen by inspection,
  not by any signal from whether the ranked results were actually useful.
- `add-review-and-archive-recall` added a `review` tool (`src/tools/index.ts`,
  `handleReview`) so humans can `keep` or `archive` T1 memories — but that queue is
  driven purely by `review_due` timers. There is no signal that flags "this memory
  gets recalled constantly and is never useful" independent of its age, which is
  exactly the kind of memory a review queue should surface early.

`access_count` (`src/domain/lifecycle.ts:94`) already conflates "retrieved" with
"useful" — every recall hit increments it and, per composite ranking, *raises* that
memory's future rank, regardless of whether the caller actually used what came back.
There is no way to record the other half of the signal: did this result help.

Per `codeaudit/storagefeaturebrainstorm.md` item 6.1, even sparse feedback is valuable
because it lets a future change tune ranking weights, decay rates, and dedup
thresholds against reality instead of vibes — but collecting that signal and acting on
it are separable, and collection is the small, low-risk half.

## What Changes

- Add a dedicated `feedback` MCP tool: `feedback(id, useful, query?, score?)`. `id` is
  a memory UUID (as returned in a prior `recall`/`search` result); `useful` is a
  boolean; `query` and `score` are optional context (the recall/search query text and
  the score the caller saw) carried through for future analysis, not validated against
  any live result set.
- Persist each call as an immutable event row in a new `recall_feedback` SQLite table
  (`src/storage/sqlite.ts`, alongside `memory_revisions`/`memory_archive`) — append-only,
  namespace derived from the referenced memory, never mutates the memory row itself.
- No aggregation, no read/list surface, no ranking or lifecycle effect in this change —
  events are written and otherwise inert (see design.md Non-Goals). A later change
  consumes them.
- Register schema/handler; update `CLAUDE.md`'s canonical tool list, README ×5, bump
  `package.json` version.

## Capabilities

### New Capabilities
- `recall-feedback`: Callers can record whether a previously recalled/searched memory
  was actually useful, persisted as an auditable event stream keyed to the memory, with
  no immediate effect on ranking or lifecycle — the raw material a future tuning change
  needs but does not yet have.

### Modified Capabilities

## Impact

- Affected code: `src/tools/schemas.ts` (new `FeedbackInputSchema` +
  `MCP_TOOL_DEFINITIONS` entry), `src/tools/index.ts` (new `handleFeedback`, dispatcher
  case), `src/storage/sqlite.ts` (new `recall_feedback` table + `recordFeedback`
  method), `src/domain/types.ts` (new `RecallFeedbackEntry` type), tests.
- MCP surface grows by one tool → `CLAUDE.md` + README ×5 sync in the same change
  (repo rule).
- No schema migrations beyond an additive `CREATE TABLE IF NOT EXISTS`: the existing
  `memories`, `memory_revisions`, `memory_archive` tables are untouched.
- Depends on: nothing functionally, but the table this change adds is the input a
  future ranking-tuning change (unblocked, not implemented, by this proposal) will
  read — see design.md Non-Goals.
