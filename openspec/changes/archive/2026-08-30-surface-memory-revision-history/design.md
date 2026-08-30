## Context

`memory_revisions` rows accumulate on every UPDATE (and the pipeline's DELETE+replace
lineage already links replacements via `merged_from`). The read side exists as
`SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC`
(`src/storage/sqlite.ts:1069`) but nothing calls it from the MCP surface.

The repair/restore machinery (`StorageManager.updateMemory`, re-embed on content
change, audit logging with structured `LifecycleAuditDetails`) provides every piece a
revert needs; this change is surface plumbing, not new storage capability.

## Goals / Non-Goals

Goals:
- Read access to revision history via both resource (`memory://{id}/revisions`) and
  tool (`revisions` action `list`).
- A safe revert that keeps SQLite and Qdrant consistent and leaves an audit trail.

Non-Goals:
- No diffing/rendering of revisions (clients can diff).
- No revision pruning/retention policy (revisions are small; a cap can come later).
- No revert of deleted memories (that is the archive's domain).

## Decisions

- **Tool + resource, not just resource**: stdio MCP clients vary in resource support;
  the tool guarantees reachability. Both read through one storage method to avoid
  drift.
- **Revert = new revision, not history rewrite**: reverting to revision N writes the
  memory's current content to history and sets content to N's content via
  `updateMemory` (new checksum, re-embed, `last_operation: 'UPDATE'`). History is
  append-only; `revision` numbers never reuse.
- **Audit**: `logAudit('REVISE', ...)` with `LifecycleAuditDetails.action: 'revise'`
  and the source revision number in `details` — distinguishable from generic UPDATEs.
- **Embedding unavailable**: revert throws `EMBEDDING_UNAVAILABLE` (no silent
  `vector_synced: false` write) — a revert is an explicit, retryable user action, so
  fail-loud beats degraded-write here.
- **Namespace guard**: the tool resolves the memory first and scopes visibility the
  same way `forget` does (`getMemoryById` then act), so cross-namespace revision
  reads are not possible via guessed IDs beyond what `memory://{id}` already allows.

## Risks / Trade-offs

- Revision content can contain data the current memory no longer has (that is the
  point) — resource reads must apply the same secret-redaction posture as other reads
  (none today; content was already accepted past `containsSecret` at write time).
- Unbounded history growth: accepted for now; noted as follow-up (`retention for
  memory_revisions`).
