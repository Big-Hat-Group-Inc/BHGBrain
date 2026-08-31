## Context

`recall` (`src/tools/index.ts:156-205`, `handleRecall`) and `search`
(`src/tools/index.ts:224-237`, `handleSearch`) both return `SearchResult[]`
(`src/domain/types.ts:84-108`) carrying `id`, `score`, `semantic_score`, and
`fulltext_score`. Nothing downstream of that response ever comes back. The only
existing usage-derived signal is `access_count`, incremented on every recall hit
(confirmed by `add-composite-recall-ranking`'s reliance on it in
`buildSearchResults`) and used both for tier promotion (`src/domain/lifecycle.ts:94`)
and, as of that same change, ranking weight (`w_acc·log1p(access_count)`,
`src/search/index.ts`). `access_count` answers "was this retrieved" — never "was this
retrieval any good." A memory that surfaces often but is consistently the wrong answer
currently *gains* rank from that fact, which is backwards.

The write pipeline (`src/pipeline/index.ts`) and lifecycle tables
(`memory_revisions`, `memory_archive`) already establish the pattern this proposal
follows: a satellite table keyed by `memory_id`, populated by a narrow tool action,
independent of the `memories` row itself. `review`'s `keep`/`archive`/`restore`
actions (`src/tools/index.ts`, `handleReview`) are the most recent precedent for a
tool whose job is entirely "record a human judgment about a memory that already
exists," which is structurally what feedback is too.

## Goals / Non-Goals

Goals:
- Let a caller record, per memory, whether a specific retrieval was useful.
- Capture just enough context (which query, what score) that a future analysis change
  doesn't have to re-derive it, without speculatively widening the schema for uses
  that aren't designed yet.
- Zero effect on ranking, lifecycle, or any existing read path — this change is pure
  collection.
- Cheap enough for a client to call after every result it acts on: single round trip,
  no server-side state to look up first.

Non-Goals:
- **Using feedback to tune `search.ranking` weights, per-tier decay `λ`, or dedup
  thresholds.** This is the entire point named in the brainstorm item ("tuning hybrid
  weights, decay λ, and dedup thresholds against reality") and it is explicitly
  deferred — this change produces the raw events; a future change reads and acts on
  them. No aggregation query, scheduled job, or config coupling is added here.
- Surfacing "retrieved often, rarely useful" memories in `review`'s queue or anywhere
  else. That's an analysis feature layered on this table later, not a byproduct of
  writing rows.
- Any read/list/export surface for feedback events. Nothing in this change queries
  `recall_feedback` back out; verifying it landed is a `sqlite3` inspection, same as
  `audit_log` has no dedicated read tool beyond what `backup`/`repair` touch
  incidentally.
- Validating that `id`/`query`/`score` match a result the caller actually received
  from a real `recall`/`search` call. There is no session state connecting a response
  to a later `feedback` call (see Decisions), so the tool trusts the caller the same
  way `tag` trusts a caller-supplied `id`.
- Feedback on archived memories. `feedback` looks the memory up the same way `tag`
  and `forget` do (`getMemoryById`, active rows only) and returns `NOT_FOUND` if it
  isn't there; archived-memory feedback is out of scope, consistent with `recall`
  itself never surfacing archived matches.

## Decisions

- **Dedicated `feedback` tool, not a `recall(..., feedback_id)` handle.** The
  brainstorm text offers both. A handle requires the server to mint and remember an
  opaque token *before* knowing whether feedback will ever arrive — either an
  in-memory map (lost on restart, wrong for a stdio-per-session or multi-worker HTTP
  deployment, needs a TTL/eviction policy invented from nothing) or a pre-written DB
  row per *result*, not per feedback event, multiplying rows by `limit` on every call
  whether or not the caller ever responds. It also only cleanly expresses one verdict
  per `recall` call unless the handle is actually per-result, which reintroduces the
  same array-of-tokens problem `tag`/`forget`/`review` already solve by taking a
  memory `id` directly. A dedicated tool needs no new state: every `SearchResult`
  already carries the `id` the caller needs to reference, exactly like `tag(id, ...)`
  and `review(action, id)` do. It composes with `search` too (which has no analogous
  recall-only handle to attach to), so one tool covers feedback from either read path.
- **New `recall_feedback` table, not columns on `memories`.** Feedback is an event
  ("this specific look was/wasn't useful"), not a property of the memory ("this memory
  is good"). Multiple feedback events can and will accumulate for the same memory
  across different queries with different verdicts — collapsing that into a running
  counter on `memories` (e.g. `useful_count`/`not_useful_count`) would discard the
  per-event query/score context that is the entire reason to capture this now instead
  of waiting until the analysis change is designed, and it would mean rewriting the
  hot `memories` row (already written on every access-count bump) for a signal that
  has nothing to do with retrieval. This mirrors why `memory_revisions` and
  `memory_archive` are separate append-only tables rather than columns on `memories`.
- **Schema**: `recall_feedback(id INTEGER PK AUTOINCREMENT, memory_id TEXT NOT NULL,
  namespace TEXT NOT NULL, query TEXT, score REAL, useful INTEGER NOT NULL CHECK IN
  (0,1), client_id TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL)`, added
  via the same additive `CREATE TABLE IF NOT EXISTS` block as every other table in
  `src/storage/sqlite.ts` (`SCHEMA_SQL`) — no migration machinery exists in this repo
  beyond that idempotent block, so none is introduced. Indexed on `memory_id` (future
  per-memory rollups) and `created_at DESC` (future time-windowed analysis), same
  index shape as `memory_archive`.
- **Namespace is derived, not caller-supplied.** Like `tag`/`forget`/`revisions`,
  `feedback` takes only `id` and looks the memory up (`ctx.storage.sqlite.getMemoryById`)
  to get its namespace for the stored row and for `logCtx` — it is not accepted as an
  independent input that could disagree with the memory's actual namespace.
- **`query` and `score` are optional, freeform, and unvalidated against reality.**
  They exist so a future analysis change can correlate "the score that produced this
  result" with "whether it was useful" without this change having to guess the right
  shape for that analysis. `query` is capped at 500 chars (same bound as
  `QuerySchema`); `score` is `[0,1]` (same bound as `min_score`) but nullable since
  `search`'s hybrid/RRF scores aren't naturally on that scale — callers omit it rather
  than mis-scale it. Neither is cross-checked against a real prior call.
- **Not written to `audit_log`.** `audit_log` (`src/storage/sqlite.ts:242-251`) records
  operations that mutate a memory's state (`ADD`/`UPDATE`/`DELETE`/`FORGET`/lifecycle
  transitions) for compliance/recovery purposes. A feedback event mutates nothing —
  routing it through `logAudit` would mix a high-volume, low-stakes signal into a log
  whose consumers (`backup`, `repair`, compliance review) expect state-transition
  semantics. `recall_feedback` is its own stream, same reasoning as keeping
  `memory_revisions` separate from `audit_log` even though revisions are also
  per-memory history.
- **Single memory per call, no batch endpoint.** Matches `tag`/`forget`'s shape. A
  client acting on several results from one `recall` calls `feedback` once per `id`;
  batching is a convenience optimization with no new capability, deferred until real
  usage shows it matters.

## Risks / Trade-offs

- **Unbounded table growth.** Every `feedback` call is one row, forever — there is no
  TTL or retention policy here (unlike `memories`, which has tier-based expiry).
  Accepted for this change: the table is small per row (a handful of scalar columns,
  no embedding, no full content) and retention policy is exactly the kind of decision
  that belongs with the analysis change that will actually query this data, not
  invented speculatively here.
- **Self-reported, unverified signal.** Nothing stops a caller from marking feedback
  for a memory `id` it never actually recalled, or lying about `useful`. This is the
  same trust model `tag`/`forget` already extend to any `id`-taking tool; MCP callers
  are trusted actors in this system's threat model. A future analysis change should
  treat the signal as noisy, not as ground truth.
- **Collecting now, deciding later, risks the schema being wrong for the eventual
  analysis.** Mitigated by keeping the row narrow (five substantive columns) and by
  this being purely additive — a future change can add columns or a companion table
  without touching what's collected here.
- **No feedback path for `search` results retrieved via `memory://inject` or
  bootstrap-driven recalls.** Only the two explicit read tools are in scope; resource
  reads (`memory://list`, `memory://inject`) don't return the kind of discrete,
  per-result exchange feedback attaches to, and adding one there is a separate,
  unscoped decision.
