## 1. Local Atomicity and Contention

- [x] 1.1 Add a configurable SQLite busy timeout during database open and verify two connections wait and succeed under short write contention.
- [x] 1.2 Introduce composable transaction or savepoint helpers that preserve the primary error when rollback fails and verify injected rollback failures do not mask root causes.
- [x] 1.3 Make memory insert/update/delete and collection delete atomic across memory, FTS, links, revisions, and audit writes and verify failure injection leaves every projection unchanged.
- [x] 1.4 Wrap access-batch writes in one transaction and cache the fixed collection lookup statement; verify statement/transaction-count tests show one logical batch commit.

## 2. Cross-Store Mutation State Machine

- [x] 2.1 Add deletion-intent or equivalent reconciliation state and migrate single deletion to SQLite-first staging; verify every failure boundary leaves recoverable authoritative data or explicit drift.
- [x] 2.2 Apply the state machine to batched deletion with bounded ID chunks and verify mixed per-collection outcomes report exact deleted and unreconciled IDs.
- [x] 2.3 Make all compensation calls lifecycle-authorized and independently guarded; verify compensation failure logs both errors while returning the primary error.
- [x] 2.4 Make T0 revision, audit, update, vector write, and rollback semantics consistent and verify failed vector updates do not create phantom revision history.
- [x] 2.5 Classify missing update targets as `NOT_FOUND` and residual SQLite locks as retryable conflicts; verify REST/MCP error envelopes retain those codes.

## 3. Reconciliation and Vector Metadata

- [x] 3.1 Add a metadata-payload refresh path for access, expiry, review, pinning, and lifecycle changes and verify vector filters reflect local metadata updates.
- [x] 3.2 Update collection embedding identity only after all vectors converge and verify `repair --re-embed` permits subsequent writes to an existing collection.
- [x] 3.3 Refactor reconciliation to isolate per-memory failures, classify permanent poison records, and expose resume progress; verify one rejected record does not block later pages.
- [x] 3.4 Chunk all corpus-sized ID queries/updates within SQLite limits and verify a fixture above 32,766 IDs completes transactionally.
- [x] 3.5 Preserve expiry, review, and `derived_from` fields in repair and degraded writes and verify round-trip recovery fixtures retain provenance/lifecycle values.
- [x] 3.6 Ensure all required Qdrant payload indexes on existing and new collections, including tags, and verify retry after a partial index-creation failure.
- [x] 3.7 Run storage, pipeline, repair, search, and health regression suites plus `npm run lint`, `npm test`, and `npm run build`.
