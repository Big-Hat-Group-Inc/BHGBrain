## Context

SQLite is authoritative, FTS5 is a local projection, and Qdrant is a rebuildable semantic projection. Existing methods interleave these systems and compensation calls without one ordering rule; some local operations also use multiple autocommit statements. See `proposal.md` and `specs/dual-store-mutation-consistency/spec.md`.

## Goals / Non-Goals

**Goals:**
- Ensure every partial mutation leaves authoritative data intact or explicit repair state.
- Make local projections transactionally consistent.
- Make reconciliation converge despite individual poison records and model changes.

**Non-Goals:**
- Distributed transactions between SQLite and Qdrant.
- Making Qdrant an authoritative store.
- Eliminating all temporary degraded windows.

## Decisions

1. Use SQLite-first intent/tombstone state for destructive operations.
- Deletion will first record an unsynced deletion intent or otherwise make the row visibly pending, then delete the vector, then remove the local row transactionally.
- Qdrant-first deletion without pre-state was rejected because a local failure becomes invisible permanent drift.

2. Centralize local memory mutation transactions.
- Insert, update, and delete helpers will own `BEGIN` or SAVEPOINT semantics for memory, FTS, links, revisions, and audit writes; rollback errors will be suppressed only after retaining the primary error.
- Trigger-based FTS maintenance was considered but deferred because the current explicit projection supports the fallback engine and migration path.

3. Add a bounded SQLite busy timeout and classify residual lock errors as retryable conflicts.
- A few-second default will cover ordinary CLI/server overlap without hiding long lock holders.
- Retrying every statement in application code was rejected because compound operations require transaction-level semantics.

4. Represent all projection changes through a reconciliation queue/state.
- Metadata-only updates, failed compensations, and permanent provider rejections will have distinct statuses and causes; batch marker updates will chunk IDs.
- A single `vector_synced` boolean remains supported for compatibility but cannot be the only operator-facing classification.

5. Re-embedding convergence updates collection identity last.
- Each memory is re-embedded and verified first; after no mismatches remain, collection metadata adopts the active identity atomically.
- Updating collection identity at the start was rejected because it would authorize mixed-model writes.

6. Make payload-index ensuring idempotent for every collection state.
- Required fields are compared with collection payload schema on first use per process; missing indexes are created and the collection is memoized only after success.
- Keeping index creation only in the collection-create branch was rejected because partial setup cannot heal.

## Risks / Trade-offs

- [SQLite-first deletion can briefly leave an active row with a missing vector] -> Mark it pending before remote work and hide deletion-intent rows from normal reads.
- [More transaction scope increases lock duration] -> Keep remote calls outside SQLite transactions and use short local commits.
- [New reconciliation states complicate health] -> Map them to a small stable set: pending, transient-failure, permanent-failure, and deletion-pending.

## Migration Plan

1. Add reconciliation/deletion-intent schema and transactional local helpers.
2. Migrate write/update/delete paths and compensation logging.
3. Migrate metadata refresh, model migration, and per-item reconciliation.
4. Backfill missing vector payload indexes and reconcile existing stale payloads.
5. Retain compatibility reads for the old sync flag until the new state has been populated.
