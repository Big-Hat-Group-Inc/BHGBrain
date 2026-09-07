## 1. Streaming and Recovery Bounds

- [x] 1.1 Add an async paged vector iterator with payload projection, optional vectors, stable cursors, and cancellation; verify peak retained pages stay bounded in a large fake collection.
- [x] 1.2 Migrate bootstrap, checksum drift detection, and repair scans to the iterator and verify each workflow requests only required fields and reports continuation progress.
- [x] 1.3 Route repair pages through canonical mapping and transactional hydration and verify interruption leaves complete searchable pages with preserved expiry, review, and provenance.

## 2. CPU, Query, and Fan-Out Bounds

- [x] 2.1 Add a distillation candidate cap, deterministic cursor rotation, and skip metrics and verify oversized collections remain responsive and eventually rotate through candidates.
- [x] 2.2 Precompute vector norms and yield between pairwise clustering chunks; verify similarity output remains equivalent on fixtures while event-loop latency stays bounded.
- [x] 2.3 Migrate FTS5 maintenance to seekable row identity with transactional rebuild/swap and verify single-memory update/delete query plans avoid corpus scans.
- [ ] 2.4 Add indexes and keyset pagination for expiry, pinned, and re-embedding selectors and verify `EXPLAIN QUERY PLAN` tests use the intended indexes without temp sorts.

  Partially done — left unchecked because the re-embedding selector's index
  was deliberately NOT added, not merely deferred. What landed: new/renamed
  covering indexes for the expiry selector (`idx_memories_archived_expiry`)
  and the pinned selector (`idx_memories_pinned_updated`, replacing
  `idx_memories_pinned`), plus a keyset-covering `idx_memories_tier_review_due`
  (replacing `idx_memories_review_due`) for the closely related `review_due`
  selector — all verified via `EXPLAIN QUERY PLAN` tests in
  `src/storage/sqlite.test.ts` at a realistic multi-namespace row count (no
  `USE TEMP B-TREE`, no unindexed `SCAN`). `listMemoriesWithStaleEmbeddingStamp`
  (the re-embedding selector) already had keyset pagination — nothing to add
  there. I built and measured a candidate `(archived, created_at, id)` index
  for it, but at 20k rows across 5 namespaces with no `ANALYZE` stats (this
  codebase's actual runtime condition — it never runs `ANALYZE`), SQLite's
  query planner preferred that new index over both `idx_memories_ns_created`
  and `idx_memories_unsynced_created` for their own unrelated, much
  hotter-path queries (`listMemories`, `listMemoriesNeedingVectorSync`) —
  turning a narrow namespace-scoped seek into a corpus-wide `archived=0` scan
  filtered post-hoc. That is a real regression to paths this same proposal
  is trying to protect, not a wash, so I left the index out rather than
  landing a fix for one selector that quietly breaks two hotter ones. The
  reasoning and the measurement are recorded in `src/storage/sqlite.ts`
  (the comment above `idx_memories_archived_expiry`). A real fix likely needs
  either a maintained boolean column (e.g. `needs_reembed`, kept in sync with
  the active embedding identity) or running `ANALYZE`/`PRAGMA optimize`
  periodically so the cost-based planner has real cardinality to work from —
  both are bigger changes than this task implies and should be their own
  follow-up.

- [x] 2.5 Add bounded-concurrency and deadline handling to consolidation neighbor discovery and verify in-flight requests never exceed configuration and partial results carry a cursor.

## 3. Input and Output Amplification

- [x] 3.1 Add import maximum-chunk and per-chunk limits with deterministic hard splitting and verify excessive tiny or oversized chunks fail before provider calls.
- [x] 3.2 Batch import embedding/provider work while preserving per-item outcomes and verify request count scales by configured batch size rather than chunk count.
- [ ] 3.3 Add a shared response-budget assembler for tool and resource results and verify large content returns valid bounded JSON with truncation/continuation metadata.

  Partially done — left unchecked because "tool **and resource** results"
  (plural, broad) is not fully covered. What landed: a shared, unit-tested
  assembler (`src/domain/response-budget.ts`, `assembleWithinCharBudget`)
  that includes candidate items up to a character budget one at a time
  (never truncates the final JSON string), wired into the two surfaces the
  spec scenario itself names — `recall` and `search` — which now stay within
  `defaults.max_response_chars` and report `truncated: true` when trailing
  results were left out (covered by tests in `src/tools/index.test.ts` and
  reflected in the `recall`/`search` `outputSchema`s in
  `src/tools/schemas.ts`, plus README.md and all four translations). NOT
  wired into any MCP *resource* handler (`memory://list`, `category://list`,
  `collection://list`, `memory://{id}/revisions`, ...) or into other
  list-returning tools (`revisions`, `collections list`, `consolidate list`'s
  own cluster array, etc.) — those still return unbounded arrays. Doing this
  properly and safely for every one of those surfaces (each has its own
  pagination/limit conventions to reconcile with a byte budget) is
  substantial additional work; the assembler itself is generic and ready for
  it, but I did not want to bolt it onto a dozen more surfaces without the
  same level of scrutiny (and tests) the two I did cover got.

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
  `npm run eval`, and `npm run build`" — **did** run, all green: full
  `npm test` (1158/1158 passing, up from the 1118 baseline), `npm run
  lint` clean except a pre-existing, unrelated `tsconfig.test.json` type-check
  failure confirmed via `git stash` to predate this change entirely (see the
  final report), `npm run eval` (recall@1 0.84 / recall@5,10 1.00 / MRR
  0.9133 — byte-identical to the pre-change baseline, confirming the BM25
  weight-alignment fix in task 2.3 did not regress ranking quality), and
  `npm run build` (clean `tsc` compile).
