## Context

The tiered lifecycle (`add-tiered-memory-lifecycle`) shipped archive-before-delete and
review scheduling as *write-side* mechanics: `review_due` stamped on T1 memories,
`archived_memories` populated by GC/cleanup. This change is the read-side complement
and deliberately introduces no new lifecycle policy — `keep` re-applies the existing
`MemoryLifecycleService` computations; `archive` and `restore` reuse the existing
transition paths and their `LifecycleAuditOperation` audit events (`ARCHIVE`,
`RESTORE` are already in the type union).

A hard constraint shapes archive search and restore: `archived_memories` retains
summary, tags, tier, and access stats — **not content and not vectors**
(`ArchiveRecord`, `src/domain/types.ts:192`). Archive search is therefore
metadata-term search, and a restored memory is a provenance-carrying stub, not a
resurrection.

## Goals / Non-Goals

Goals:
- Make the review queue actionable with the smallest possible action set (list /
  keep / archive) that closes the curation loop.
- Make the archive searchable and restorable within what the schema retains.

Non-Goals:
- No content editing inside `review` (revision is `remember`'s UPDATE flow; one write
  path for content).
- No semantic search over archives (no vectors there, by design).
- No archive retention policy changes.

## Decisions

- **One tool, four actions** rather than two tools: review and archive-restore share
  the "curation" concern and an id-oriented action shape; a single `review` tool
  keeps the MCP surface growth minimal (the repo pays a five-README tax per tool).
- **`keep` refreshes both `review_due` and `expires_at`**: a human confirmation is at
  least as strong a signal as an automated access, so it gets the full sliding-window
  treatment regardless of `sliding_window_enabled` (explicit curation beats passive
  policy; called out in docs).
- **Restore creates a stub**: content = archived summary, tagged with its original
  tags plus a `restored-from-archive` marker tag, original tier re-applied, embedded
  normally so it participates in search. The audit details link the archive row id.
  This is honest about data loss rather than pretending the memory survived intact.
- **`include_archived` results are additive**: archived matches are appended after
  active results with an explicit `archived: true` flag, so default consumers see no
  contract change and opted-in consumers can render them distinctly.

## Risks / Trade-offs

- Restored stubs have thin content; they may rank oddly in semantic search (their
  embedding is of a ≤120-char summary). Accepted: the stub exists to be found and
  re-fleshed by the user, and the marker tag makes them identifiable.
- Archive search via LIKE inherits the legacy fulltext limitations until FTS5 lands;
  the storage method is written so the FTS5 change can adopt it without contract
  change.
