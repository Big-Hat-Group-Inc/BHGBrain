## 1. Streaming and Recovery Bounds

- [x] 1.1 Add an async paged vector iterator with payload projection, optional vectors, stable cursors, and cancellation; verify peak retained pages stay bounded in a large fake collection.
- [x] 1.2 Migrate bootstrap, checksum drift detection, and repair scans to the iterator and verify each workflow requests only required fields and reports continuation progress.
- [x] 1.3 Route repair pages through canonical mapping and transactional hydration and verify interruption leaves complete searchable pages with preserved expiry, review, and provenance.

## 2. CPU, Query, and Fan-Out Bounds

- [x] 2.1 Add a distillation candidate cap, deterministic cursor rotation, and skip metrics and verify oversized collections remain responsive and eventually rotate through candidates.
- [x] 2.2 Precompute vector norms and yield between pairwise clustering chunks; verify similarity output remains equivalent on fixtures while event-loop latency stays bounded.
- [x] 2.3 Migrate FTS5 maintenance to seekable row identity with transactional rebuild/swap and verify single-memory update/delete query plans avoid corpus scans.
- [x] 2.4 Add indexes and keyset pagination for expiry, pinned, and re-embedding selectors and verify `EXPLAIN QUERY PLAN` tests use the intended indexes without temp sorts.

  Done. Builds on the expiry/pinned/review_due indexes landed earlier
  (`idx_memories_archived_expiry`, `idx_memories_pinned_updated`,
  `idx_memories_tier_review_due`) by adding the fourth, previously-rejected
  candidate: `idx_memories_archived_created` on `(archived, created_at, id)`,
  covering `listMemoriesWithStaleEmbeddingStamp` (the re-embedding selector —
  `embedding_model != ?` is never seekable, but `archived = 0` plus its
  `ORDER BY created_at ASC, id ASC` both are). The earlier note's measured
  regression was real — without a guard, the planner prefers this new index
  over `idx_memories_ns_created`/`idx_memories_ns_coll_created`/
  `idx_memories_unsynced_created` for their own unrelated queries — so it now
  ships alongside explicit `INDEXED BY` hints pinning `listMemories`,
  `listMemoriesInCollection`, and `listMemoriesNeedingVectorSync` to their own
  original indexes regardless of what the (ANALYZE-less) planner would guess.
  `EXPLAIN QUERY PLAN` tests in `src/storage/sqlite.test.ts` cover both
  halves: the new index winning for the re-embed selector with no temp
  B-tree, and — reproduced directly, not just asserted — that removing the
  `INDEXED BY` hints would let the new index wrongly win over
  `idx_memories_ns_created`/`idx_memories_unsynced_created` once it exists,
  confirming the hints are load-bearing rather than decorative.

- [x] 2.5 Add bounded-concurrency and deadline handling to consolidation neighbor discovery and verify in-flight requests never exceed configuration and partial results carry a cursor.

## 3. Input and Output Amplification

- [x] 3.1 Add import maximum-chunk and per-chunk limits with deterministic hard splitting and verify excessive tiny or oversized chunks fail before provider calls.
- [x] 3.2 Batch import embedding/provider work while preserving per-item outcomes and verify request count scales by configured batch size rather than chunk count.
- [ ] 3.3 Add a shared response-budget assembler for tool and resource results and verify large content returns valid bounded JSON with truncation/continuation metadata.

  Substantially done — left unchecked because one surface is still
  unbounded. The shared assembler (`src/domain/response-budget.ts`,
  `assembleWithinCharBudget`) is now wired into every list-returning tool
  and resource except one:
  - `recall`/`search` (previously landed).
  - `revisions` tool (`action: "list"`) and `memory://{id}/revisions`
    resource — each revision carries full historical `content`, and
    `revisions_per_memory_max` may be configured unbounded, so this was a
    real, not theoretical, gap.
  - `collections` tool (`action: "list"`) and `collection://list` resource.
  - `category://list` resource (rows were already capped to a 200-char
    preview, so this is low-risk, but budgeted for consistency).
  - `memory://list` and `collection://{name}` resources — the trickier pair,
    since both already do cursor pagination: the assembler now runs over the
    already limit-bounded page *before* the resume cursor is computed, and
    the cursor is derived from the last *budget-kept* item, not the last
    page item, with `truncated = hasMore || budgeted.truncated`. Otherwise a
    client resuming from a byte-budget-cut page would silently skip whatever
    the budget (rather than the page limit) had cut. Covered by a dedicated
    test forcing a budget cut below the page limit and asserting the next
    cursor call returns exactly the skipped item.

  All of the above are covered by tests (`src/tools/index.test.ts`,
  `src/resources/index.test.ts`) and documented in README.md plus all four
  translations, with `.claude`-tracked version bump per AGENTS.md.

  NOT wired: `consolidate` list's cluster array (`handleConsolidateList`).
  Its output is clusters of members from a union-find pass, not a flat
  array of independent records — truncating candidate-item-at-a-time would
  risk splitting a cluster across the budget boundary, corrupting the merge
  semantics downstream. It also already has its own three-way, deadline-aware
  scan cursor (`processed`/`deadlineReached`/`page.length===maxScan`) that
  would need to interact correctly with a second (byte-budget) truncation
  axis without double-counting or dropping already-resolved-but-unreturned
  clusters. That is real design work, not a reuse of the existing assembler,
  and is left as its own follow-up.

- [ ] 3.4 Add scale fixtures/benchmarks for scanning, clustering, FTS maintenance, repair, import, and response assembly, then run targeted tests plus `npm run lint`, `npm test`, `npm run eval`, and `npm run build`.

  Partially done — left unchecked because no dedicated, repeatable
  scale/benchmark fixtures (a harness producing throughput/latency numbers)
  were added; this repo has no existing benchmark convention/script to
  extend (checked: no `bench` npm script, no `scripts/` or `src/eval/`
  benchmark harness). What I did instead, alongside each task above: large,
  realistic-scale *correctness* fixtures embedded directly in that task's own
  test file — e.g. a 300-candidate clustering test asserting the
  cooperative-yield path runs and produces the correct partition
  (`distillation-cluster.test.ts`), `EXPLAIN QUERY PLAN` index-selection
  tests run against a 20,000-row/5-namespace populated database (verified via
  a throwaway script before writing the assertions, not just the unit-test
  scale), and paged-iterator tests confirming a page never grows to hold more
  than its own batch (`qdrant.test.ts`). These prove correctness and
  intended index/plan selection at scale, not throughput or latency bounds.
  The second half — "run targeted tests plus `npm run lint`, `npm test`,
  `npm run eval`, and `npm run build`" — **did** run, all green, and stayed
  green through the follow-through on tasks 2.4/3.3 above: `npm run lint`
  is now fully clean (`tsc --noEmit` on both `tsconfig.json` and
  `tsconfig.test.json`, plus `eslint src`) — the `tsconfig.test.json`
  type-check failure this note previously flagged as pre-existing no longer
  reproduces (something in the intervening work fixed it; re-verified
  independently before landing 2.4/3.3), full `npm test` (1405/1405
  passing, up from the 1158 cited earlier — more tests have landed since,
  including new coverage for 2.4/3.3), `npm run eval` (recall@1 0.84 /
  recall@5,10 1.00 / MRR 0.9133 — unchanged from the pre-change baseline,
  confirming neither the BM25 weight-alignment fix in task 2.3 nor the new
  `idx_memories_archived_created`/`INDEXED BY` query-plan changes in task
  2.4 regressed ranking quality), and `npm run build` (clean `tsc` compile).

  Checked the spec this task implements
  (`openspec/changes/bound-corpus-scale-workflows/specs/corpus-scale-work-bounds/spec.md`)
  and its design/proposal: none mention "benchmark", "throughput", or
  "latency" — every ADDED requirement is a bounded-behavior/correctness
  assertion, not a performance-number one, and grepping all other
  `openspec/changes/*/tasks.md` in this repo turns up no other proposal that
  ever asks for one either (no existing convention to extend, no `bench`
  npm script, no benchmark harness under `scripts/` or `src/eval/`). Given
  that, and that this repo's own convention (see 2.4/3.3 above) is to leave
  a checkbox literally unchecked whenever the checklist's exact wording
  isn't 100% satisfied even when the underlying intent is met, this stays
  unchecked rather than treating the lint/test/eval/build half as enough on
  its own — the benchmark-harness gap named in the checklist's own wording
  is real and undone, just judged (in the absence of any spec requirement
  or repo convention calling for it) as new, disproportionate scope rather
  than something to build under this task.
