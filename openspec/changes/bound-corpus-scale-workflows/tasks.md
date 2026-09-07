## 1. Streaming and Recovery Bounds

- [ ] 1.1 Add an async paged vector iterator with payload projection, optional vectors, stable cursors, and cancellation; verify peak retained pages stay bounded in a large fake collection.
- [ ] 1.2 Migrate bootstrap, checksum drift detection, and repair scans to the iterator and verify each workflow requests only required fields and reports continuation progress.
- [ ] 1.3 Route repair pages through canonical mapping and transactional hydration and verify interruption leaves complete searchable pages with preserved expiry, review, and provenance.

## 2. CPU, Query, and Fan-Out Bounds

- [ ] 2.1 Add a distillation candidate cap, deterministic cursor rotation, and skip metrics and verify oversized collections remain responsive and eventually rotate through candidates.
- [ ] 2.2 Precompute vector norms and yield between pairwise clustering chunks; verify similarity output remains equivalent on fixtures while event-loop latency stays bounded.
- [ ] 2.3 Migrate FTS5 maintenance to seekable row identity with transactional rebuild/swap and verify single-memory update/delete query plans avoid corpus scans.
- [ ] 2.4 Add indexes and keyset pagination for expiry, pinned, and re-embedding selectors and verify `EXPLAIN QUERY PLAN` tests use the intended indexes without temp sorts.
- [ ] 2.5 Add bounded-concurrency and deadline handling to consolidation neighbor discovery and verify in-flight requests never exceed configuration and partial results carry a cursor.

## 3. Input and Output Amplification

- [ ] 3.1 Add import maximum-chunk and per-chunk limits with deterministic hard splitting and verify excessive tiny or oversized chunks fail before provider calls.
- [ ] 3.2 Batch import embedding/provider work while preserving per-item outcomes and verify request count scales by configured batch size rather than chunk count.
- [ ] 3.3 Add a shared response-budget assembler for tool and resource results and verify large content returns valid bounded JSON with truncation/continuation metadata.
- [ ] 3.4 Add scale fixtures/benchmarks for scanning, clustering, FTS maintenance, repair, import, and response assembly, then run targeted tests plus `npm run lint`, `npm test`, `npm run eval`, and `npm run build`.
