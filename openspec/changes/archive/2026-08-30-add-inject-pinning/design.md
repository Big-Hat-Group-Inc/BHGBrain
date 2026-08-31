## Context

`buildInjectPayload` (`src/resources/index.ts:205-308`) already runs in two
phases: categories fill their reserved share of the budget first
(`src/resources/index.ts:237-267`), then the memory section is selected
either by recency (`this.storage.sqlite.listMemories`, hintless) or hybrid
relevance (`this.search.searchForInject`, hinted) and appended through the
same budget-aware `appendBlock` helper (`src/resources/index.ts:220-235`).
Near-duplicate suppression (`suppressNearDuplicates`,
`src/resources/index.ts:192-203`) runs only on the hint-selected candidate
list, using vectors the hybrid search leg returns; recency candidates
(`MemoryRecordWithoutEmbedding`, `src/storage/sqlite.ts:27`) never carry a
vector because embeddings live only in Qdrant, not SQLite
(`src/storage/sqlite.ts:625-638`).

`MemoryRecord` (`src/domain/types.ts:37-69`) already carries several
boolean-ish lifecycle flags stored the same way (`archived`,
`decay_eligible`, `vector_synced`) — added as `INTEGER NOT NULL DEFAULT`
columns via the additive migration list in `ensureMemoryColumns`
(`src/storage/sqlite.ts:1798-1832`), read back through `getBoolean`
(`src/storage/sqlite.ts:1871`), and round-tripped generically by
`updateMemory` (`src/storage/sqlite.ts:578-613`), which special-cases only
the boolean columns' `1`/`0` coercion — any new boolean field with the same
treatment works with zero changes to `updateMemory` itself. `T0` retention
already gives foundational memories a durability/ranking edge
(`src/search/index.ts:312-330`) but has no inject-inclusion guarantee — that
gap is what this change closes, deliberately by a different mechanism.

## Goals / Non-Goals

Goals:
- A memory can be marked so it is always present in both inject templates'
  memory section, independent of the recency/relevance algorithm that
  otherwise selects that section.
- The guarantee is bounded (a small per-namespace cap) so it cannot become a
  second unbounded inject path that reintroduces the "categories starve
  memories" problem `add-relevance-conditioned-inject` just fixed, aimed at
  pinned content this time.
- Pins are durable across `repair --mode from-qdrant` rebuilds and
  cross-device sync, like every other lifecycle flag on the row.

Non-Goals:
- No change to `search`/`recall` ordering, `SearchResult`, or composite
  ranking (`add-composite-recall-ranking`). Pinning is an inject-selection
  concept only — this is the explicit distinction from T0 called out in the
  original brainstorm item.
- No vector-similarity comparison between pinned memories and the
  relevance/recency candidate set (see Decisions — cost/benefit doesn't
  justify it).
- No UI/CLI surface beyond the two existing tools (`remember`, `tag`); no new
  MCP tool or resource.
- `WriteResult` (`src/domain/types.ts:110-117`) does not gain a `pinned`
  field — it already omits `importance`/`retention_tier` on the same
  principle of not echoing every stored field back on write.

## Decisions

- **Field and storage**: `pinned: boolean` on `MemoryRecord`
  (`src/domain/types.ts:37-69`), stored as `pinned INTEGER NOT NULL DEFAULT 0`
  with an additive migration entry in `ensureMemoryColumns`
  (`src/storage/sqlite.ts:1816-1825`) and a
  `idx_memories_pinned ON memories(namespace, pinned)` index
  (alongside `idx_memories_archived`, `src/storage/sqlite.ts:213`) so
  `listPinnedMemories(namespace)` is an index range scan, not a table scan.
  Read back via `getBoolean` in `rowToMemory` (`src/storage/sqlite.ts:1672-
  1680`); written through the existing generic `updateMemory` boolean-column
  branch (`src/storage/sqlite.ts:590-592`, add `pinned` alongside
  `decay_eligible`/`archived`/`vector_synced`).

- **Settable via `remember` and `tag`, with different merge semantics on
  each — explicit-set-wins, not OR-merge**: `RememberInputSchema`
  (`src/domain/schemas.ts:26-36`) gets an optional `pinned` boolean. On ADD it
  sets the initial value (default `false`). On UPDATE (the dedup merge paths
  at `src/pipeline/index.ts:162-191` and the fallback at
  `src/pipeline/index.ts:385-413`), `pinned` follows the same
  "explicit input wins, otherwise preserve existing" rule already used for
  `retention_tier` via `explicitTier` (`src/pipeline/index.ts:102`, `:367`) —
  **not** the `Math.max` OR-merge used for `importance`
  (`src/pipeline/index.ts:176`, `:397`). An OR-merge would make unpinning via
  `remember` impossible (any re-`remember` without `pinned: false` would
  re-pin); defaulting unset `pinned` to `false` on every UPDATE would
  silently unpin a memory the first time its content is corrected — exactly
  the "critical fact stays pinned across updates" case this feature exists
  for. `TagInputSchema` (`src/domain/schemas.ts:64-68`) gets a parallel
  optional `pinned` boolean beside `add`/`remove`; `handleTag`
  (`src/tools/index.ts:239-260`) applies it via `updateMemory` only when
  present, giving a dedicated pin/unpin toggle that doesn't require
  re-submitting content.

- **Per-namespace cap enforced at write time, not inject time**: a config
  limit (`defaults.pin_limit_per_namespace`, default 20, alongside
  `auto_inject_limit` at `src/config/index.ts:113-120`) is checked in
  `handleRemember`/`handleTag` whenever a mutation would newly set
  `pinned: true` (via a new `countPinnedMemories(namespace)` storage method);
  exceeding it throws `invalidInput` (`src/errors/index.js`), the same
  pattern `handleTag` already uses for the 20-tag limit
  (`src/tools/index.ts:257-259`). Enforcing the cap at pin-time, rather than
  truncating pinned content at inject-time, keeps the inject-time contract
  simple ("all pins are attempted, in full, before anything else") and gives
  the operator an actionable, explicit signal instead of a payload that
  silently drops one of their pins under budget pressure.

- **Where pinned memories are injected, and from which budget**: a new step
  in `buildInjectPayload` (`src/resources/index.ts:205-308`), inserted
  between category assembly (step 1, `:237-267`) and the existing
  recency/relevance selection (step 2, `:269-296`), fetches
  `listPinnedMemories(namespace)` (ordered `updated_at DESC` for a stable,
  "most recently affirmed first" tie-break) and appends them via the same
  `appendBlock` budget mechanics, before the recency/relevance candidates.
  This runs identically for `memory://inject` and `memory://inject/{hint}` —
  the branch on `trimmedHint` (`src/resources/index.ts:274-281`) only decides
  *which algorithm fills the rest of the section*, not whether pins are
  included, which is how the "applies to both templates" requirement is
  met structurally rather than by duplicating logic per template. Pinned
  memories draw from the memory section's existing reserved share
  (`auto_inject.memory_budget_fraction` of the total budget), not a third,
  separate carve-out: a third budget fraction multiplies config surface for
  a case the pin cap already bounds tightly — worked example, 20 pins ×
  ~250 chars average ≈ 5,000 chars against the default reserved share of
  `0.4 × 30,000 = 12,000` chars, comfortably inside it. The
  recency/relevance candidate list then excludes any ID already included via
  pinning (a plain `Set` check) so a memory that is both pinned and
  independently top-ranked appears exactly once.

- **Near-duplicate suppression: pinned memories are exempt in both
  directions**. `suppressNearDuplicates` (`src/resources/index.ts:192-203`)
  continues to run only over the recency/relevance candidate list, exactly as
  today; pinned memories are never passed through it, and are not pre-seeded
  into its `selected` accumulator either. Two consequences, both intentional:
  (1) two near-duplicate pinned memories are both injected — suppression
  is a "make efficient use of scarce budget" convenience, and silently
  dropping one half of an explicit operator override defeats the feature;
  the operator who over-pins similar content can unpin one directly. (2) a
  pinned memory is never suppressed by, and never suppresses, a
  relevance/recency candidate that happens to be its near-duplicate — doing
  that cross-set comparison would require a vector for every pinned memory,
  and pinned memories are read via `listPinnedMemories`, a plain SQLite read
  like the existing hintless recency path — `MemoryRecordWithoutEmbedding`
  (`src/storage/sqlite.ts:27`) has no `vector` field because embeddings live
  only in Qdrant (`src/storage/sqlite.ts:625-638`). Fetching one would mean
  an extra Qdrant round trip on every inject call, including the hintless
  path, which today makes zero embedding-store calls
  (`add-relevance-conditioned-inject`'s design explicitly keeps that path a
  pure SQLite read). Exact-duplicate injection (the same memory appearing
  twice) is fully prevented anyway by the cheap ID-exclusion above; residual
  near-duplicate *content* between a pin and a relevance pick is accepted as
  a low-cost trade, not a correctness bug.

- **No effect on `search`/`recall`/composite ranking**: `pinned` is not added
  to `SearchResult` (`src/domain/types.ts:84-108`) and `compositeScore`
  (`src/search/index.ts:312-330`) is untouched. This is the load-bearing
  distinction from T0 in the original brainstorm item — T0 nudges ranking
  and never expires; `pinned` guarantees inject inclusion and has no ranking
  or retention effect of its own. A memory can be T0 and pinned, T0 and
  unpinned, or any tier and pinned — the two flags are orthogonal.

- **Durability across repair/cross-device sync**: `pinned` is added to
  `toQdrantPayload` (`src/storage/index.ts:801-830`) and parsed back out of
  the payload in `upsertMemoryFromPayload`
  (`src/storage/sqlite.ts:504-576`, alongside `retention_tier`/`archived`
  parsing at `:519`, `:529`), so `repair --mode from-qdrant` and the
  cross-device Qdrant-payload fallback path
  (`buildResultFromQdrantPayload`, referenced from
  `src/search/index.ts:332-378`) both preserve pin state instead of silently
  resetting it to `false` on rebuild.

- **Kill switch**: `auto_inject.pinned_enabled` (default `true`, alongside
  `dedup_suppression` at `src/config/index.ts:190-205`) lets an operator
  disable pinned-memory injection without unpinning every memory — when
  `false`, `buildInjectPayload` skips the new step entirely and both
  templates behave exactly as they do today. The per-namespace pin *cap* is
  still enforced at write time regardless of this switch — cheap to check,
  and it should not be possible to silently accumulate hundreds of pins
  while the switch is off and then have them all activate when it's flipped
  back on.

## Risks / Trade-offs

- **Cap rejects legitimate large pin sets.** 20 is a starting default sized
  to the worked-example budget math above, not a hard product ceiling; it is
  operator-configurable per namespace via `defaults.pin_limit_per_namespace`
  the same way every other numeric knob in this section is.
- **Explicit-set-wins UPDATE semantics is a subtler contract than OR-merge.**
  A caller who wants "always keep this pinned unless I explicitly say
  otherwise" gets that for free (the common case); a caller who wants "reset
  pin state on every `remember`" must pass `pinned` explicitly every time.
  Documented in README; `tag` is offered as the more explicit, dedicated
  toggle for callers who find `remember`'s implicit-preserve behavior
  surprising.
- **"Always injected" is budget-bounded, not absolute.** If pinned content
  alone exceeds the memory section's reserved share (only reachable by
  pinning many large memories up to the cap), the existing truncation and
  `truncated: true` signaling still applies per item, exactly as it does for
  category and relevance content today. This is a known softening of
  "always" — mitigated, not eliminated, by the cap and its budget math.
- **Accepted near-duplicate content between a pin and a relevance/recency
  pick.** As decided above, this is a deliberate cost/benefit call (avoid an
  extra Qdrant round trip on every inject call) rather than an oversight; it
  wastes at most a little budget on repetitive content, never correctness.
