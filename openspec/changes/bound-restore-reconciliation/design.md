## Context

Prior restore work (`restore-dual-store-backup-consistency`, `harden-post-restore-reconciliation`) established the correct invariants: SQLite is the restore source of truth, vector state is derived, SQLite activation is the success boundary, and post-activation vector failures degrade readiness instead of negating activation. Both audits confirmed those invariants hold.

What remains are operational robustness gaps those changes explicitly deferred (the prior design's Open Question literally asked whether large restores should move reconciliation to a background loop). Today, `restoreVectorStateAfterActivation` (`src/backup/index.ts:163-177`) always marks the whole dataset unsynced, drops every managed Qdrant collection, and re-embeds the entire corpus inline via `reconcileVectorsFromSqlite` (`src/storage/index.ts:204-258`) — synchronously, unbounded, and while holding the restore lifecycle lock. For a large brain or slow provider this is an O(N) re-embed bound to an external dependency's latency, with a wide window in which Qdrant is empty and no automatic recovery if reconciliation fails.

This change makes reconciliation bounded, drift-aware, availability-preserving, and durably resumable — without changing the SQLite-first recovery model or the backup artifact format.

## Goals / Non-Goals

**Goals:**
- Reconcile only the actual vector drift on restore; avoid re-embedding when vectors already match.
- Bound reconciliation (timeout + iteration cap) and avoid holding the lifecycle lock for the full re-embed.
- Keep semantic search usable until a rebuild succeeds; do not leave search blank on failure.
- Guarantee durable, resumable reconciliation progress with a bounded crash-rework window.
- Document the intentional SQLite-only backup format.

**Non-Goals:**
- Changing the backup artifact format or bundling Qdrant snapshots into backups.
- Altering the SQLite-first recovery model or the activation/degraded readiness semantics already shipped.
- Redesigning non-restore write-path synchronization or MCP transport behavior.

## Decisions

1. Reconcile drift, not the whole corpus.
- Decision: compare restored SQLite rows against existing Qdrant points (content/payload hash or sync marker) and re-embed/upsert only rows that actually differ or are missing.
- Rationale: embedding is the dominant cost; a no-drift restore should be near-free instead of O(N) API calls.
- Alternative considered: keep unconditional full clear + rebuild. Rejected because it pays full embedding cost even when Qdrant was already correct.

2. Bound reconciliation and release the lifecycle lock early.
- Decision: after SQLite activation, return `reconciling`/`pending` promptly; run remaining reconciliation in a bounded background task with a per-run timeout and iteration/cap guard, not under the restore lifecycle lock.
- Rationale: a fast metadata activation must not become an open-ended operation bound to embedding-provider latency, and the lock must not be held for minutes.
- Alternative considered: keep inline-to-completion with no bound. Rejected because a slow/hanging provider blocks restore and the lifecycle lock indefinitely.

3. Rebuild before destroying; retry/degrade on failure.
- Decision: do not drop managed collections before a successful rebuild — rebuild into fresh collections and swap, or defer the destructive clear until embeddings are confirmed available; on failure surface a degraded signal and an auto-retry path.
- Rationale: never trust stale vectors, but also never leave search fully blank with no recovery when reconciliation fails.
- Alternative considered: keep clear-before-rebuild with manual recovery only. Rejected because it widens the empty-vector window and requires an external trigger to recover.

4. Bound durability at batch granularity with idempotent replay.
- Decision: flush sync marks at batch granularity so a hard crash loses at most one batch; rely on idempotent re-upsert so restart resumes from the remaining unsynced set without duplication, and document this guarantee.
- Rationale: per-item flush is too costly; per-batch bounds rework while keeping correctness via idempotency.
- Alternative considered: per-item durable flush. Rejected for overhead; documenting and accepting bounded idempotent replay is sufficient.

## Risks / Trade-offs

- [Drift detection via hash adds read cost and could miss drift if hashing is wrong] -> Mitigation: fall back to full rebuild when drift cannot be reliably determined (model/dimension change, missing/incompatible Qdrant state).
- [Background reconciliation runs outside the restore lock] -> Mitigation: keep it resumable from the unsynced set and gate health readiness on completion so concurrent operations see accurate `reconciling` state.
- [Rebuild-then-swap temporarily uses extra Qdrant storage] -> Mitigation: scope swap to managed collections and clean up the superseded collection after a confirmed swap.
- [Batch-granularity durability still allows one batch of redundant re-embed on crash] -> Mitigation: bounded batch size keeps rework small; idempotent upsert keeps it correct.

## Migration Plan

1. Add drift detection and gate the full clear + re-embed behind it (full rebuild only as fallback).
2. Bound `reconcileVectorsFromSqlite` (timeout + cap) and move long reconciliation out of the lifecycle-lock window into a bounded, resumable background task.
3. Switch to rebuild-then-swap (or deferred clear) so search stays available until rebuild succeeds; add auto-retry/degraded signaling.
4. Confirm batch-granularity flush and document the idempotent-replay guarantee.
5. Document the intentional SQLite-only backup format in-code.
6. Rollback strategy: revert to the prior inline full-rebuild restore; no backup format migration is involved.

## Open Questions

- What is the right drift signal — a stored content/payload hash on each Qdrant point, or the existing SQLite sync marker plus a vector-existence probe?
- Should the bound be a fixed timeout, a configurable memory-count/duration threshold, or both, and what is the default?
- Should background reconciliation be triggered/owned by the restore call, by health, or by a dedicated reconciliation worker?
