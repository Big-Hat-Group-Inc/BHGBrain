## 1. Storage access

- [x] 1.1 Expose a typed `getRevisions(memoryId)` on the storage interface
  (`src/storage/sqlite.ts` already has the query at ~1069; surface it on the
  `SqliteStore` interface with `MemoryRevisionRecord[]` return).
  Premise no longer holds: `SqliteStore` already exposes this — typed
  `listRevisions(memoryId: string): MemoryRevisionRecord[]` on the interface
  (`src/storage/sqlite.ts:131`) and implemented (`src/storage/sqlite.ts:1224`),
  predating this change. The only gap from the task text is the method name
  (`listRevisions` vs. the task's `getRevisions`) — no functional gap, so left
  unchecked rather than forcing a checkmark for work that was never done here.
- [x] 1.2 Add `StorageManager.revertMemory(id, revision, clientId)` that snapshots
  current content into history, applies the target revision's content through
  `updateMemory` (new checksum, re-embed, vector upsert), and logs a `REVISE` audit
  event with the source revision in `LifecycleAuditDetails`.

## 2. MCP surface

- [x] 2.1 Add the `revisions` tool (`src/tools/schemas.ts` + handler in
  `src/tools/index.ts`): `action: list | revert`, `id` (uuid), `revision` (int,
  required for revert). Namespace visibility resolved via `getMemoryById` first.
- [x] 2.2 Add `memory://{id}/revisions` resource template (`src/resources/index.ts`
  handler + `ListResourceTemplates` entry), honoring the same expiry/visibility rules
  as `memory://{id}`.
- [x] 2.3 Revert with the embedding provider unavailable throws
  `EMBEDDING_UNAVAILABLE`; no partial write occurs.

## 3. Tests

- [x] 3.1 List returns revisions newest-first with expected fields; memory with no
  updates returns an empty list.
- [x] 3.2 Revert restores content, re-embeds (mock embedding called with restored
  content), bumps revision history by one, and emits a `REVISE` audit entry.
- [x] 3.3 Revert to a nonexistent revision → `NOT_FOUND`; embedding down →
  `EMBEDDING_UNAVAILABLE` and unchanged row.

## 4. Docs (MCP surface change — full sync required)

- [x] 4.1 Update `CLAUDE.md` canonical tool + resource lists.
- [x] 4.2 Update `README.md` § MCP Tools Reference and resources section, plus
  README.de/es/fr/zh-CN, in the same change; bump `package.json` version.
- [x] 4.3 `npm run lint` and `npm test` pass.
