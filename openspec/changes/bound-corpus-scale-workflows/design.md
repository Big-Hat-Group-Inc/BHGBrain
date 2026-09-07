## Context

Several workflows call a whole-collection scroll helper and retain every point, while synchronous SQLite scans, quadratic clustering, serial neighbor queries, and unbounded response assembly run on the Node event loop. See `proposal.md` and `specs/corpus-scale-work-bounds/spec.md`.

## Goals / Non-Goals

**Goals:**
- Keep peak memory, concurrency, synchronous work, and response size within configured bounds.
- Preserve resumable progress and complete field fidelity across recovery workflows.
- Improve asymptotic behavior of hot corpus operations.

**Non-Goals:**
- Moving the entire storage layer to worker threads.
- Changing search relevance or distillation similarity thresholds.

## Decisions

1. Replace whole-collection helpers with an async page iterator.
- The iterator accepts payload projection and vector inclusion, returns stable cursors, and checks a cancellation/deadline signal between pages.
- Keeping `scrollAll` with a higher heap limit was rejected because corpus size remains unbounded.

2. Bound distillation before pairwise similarity.
- Candidate selection uses a configured cap and deterministic ordering; vector norms are computed once; outer-loop chunks yield to the event loop.
- Approximate clustering was considered but deferred until bounded exact clustering is measured.

3. Migrate FTS5 to seekable row identity and add query-plan assertions.
- The migration rebuilds the projection from authoritative memories using a rowid mapping or external-content design, then swaps transactionally. Hot expiry, pinned, and re-embed selectors gain covering indexes/keyset cursors.
- Repeated virtual-table scans keyed by an unindexed UUID were rejected.

4. Route repair pages through the existing atomic hydration boundary.
- One canonical payload mapper narrows fields, then each page commits with per-record savepoints and progress output.
- Point-by-point autocommit insertion was rejected because it blocks and can split memory/FTS state.

5. Reject import amplification before provider calls.
- Parsing counts and hard-splits chunks using configured limits, reports offending locations, and batches embeddings without losing per-item results.
- Letting oversized chunks degrade into unsynced memories was rejected because reconciliation repeats the permanent failure.

6. Apply response budgets during assembly.
- Shared builders track serialized character cost and return `truncated` plus a continuation cursor where the surface supports paging.
- Truncating the final JSON string was rejected because it would produce invalid or ambiguous data.

## Risks / Trade-offs

- [FTS migration is operationally expensive] -> Build from SQLite in one guarded migration and retain the old table until validation succeeds.
- [Candidate caps can defer useful distillation] -> Report skipped counts and rotate deterministic cursor windows across runs.
- [Response budgeting changes returned item counts] -> Expose truncation explicitly and document that character budget can bind before item limit.

## Migration Plan

1. Add iterator, projection, deadline, and progress primitives.
2. Migrate repair/drift/hydration callers, then distillation.
3. Add import and consolidation bounds.
4. Apply the FTS/index migration with query-plan tests.
5. Enforce response budgets across tool and resource builders.
