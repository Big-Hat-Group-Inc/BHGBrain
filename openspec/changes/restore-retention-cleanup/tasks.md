## 1. Lifecycle and State Safety

- [x] 1.1 Add scoped lifecycle-operation ownership tokens to the SQLite mutation guard and verify real-store tests allow GC-owned mutations while rejecting concurrent unrelated writes.
- [x] 1.2 Thread lifecycle ownership through archive, delete, audit, prune, retention-state, and compensation APIs and verify cleanup no longer rejects its own operations.
- [x] 1.3 Move degraded-state persistence outside or safely inside lifecycle release and verify a forced cleanup failure reports the original cause and records degraded state.
- [x] 1.4 Add `MAX(revision) + 1` revision allocation in the owning transaction and verify updates succeed after revision pruning.

## 2. Bounded and Retry-Safe Cleanup

- [x] 2.1 Add an archive deduplication migration plus unique memory identity and verify repeated archive attempts converge to one row.
- [x] 2.2 Add keyset-paged expired-memory selection with row and elapsed-time budgets and verify a large fixture completes over multiple deterministic passes.
- [x] 2.3 Extend GC and dry-run results with scanned, remaining, continuation, and unreconciled fields and verify response serialization stays bounded.
- [x] 2.4 Narrow collection-info not-found handling and skip compaction on inspection failure; verify a simulated 503 never produces a fabricated deletion ratio.

## 3. Scheduling and Verification

- [x] 3.1 Validate retention and distillation cron expressions for syntax and satisfiability and verify invalid configuration identifies the exact field.
- [x] 3.2 Track scheduler armed, last-run, and failure state in health and verify an injected scheduling failure degrades health.
- [x] 3.3 Raise cleanup failure logs to warn or error with structured causes and verify log-capture tests distinguish failed, degraded, and successful runs.
- [x] 3.4 Add a real-SQLite end-to-end GC test covering archive, vector delete, local delete, pruning, and `last_success_at`, then run `npm run lint`, targeted retention tests, and `npm run build`.
