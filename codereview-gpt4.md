# BHGBrain Code Review

Scope: current working tree as reviewed on 2026-03-21.

Baseline health:
- `npm run lint` passed
- `npm test` passed (`127` tests across `19` files)
- `npm run build` passed

## Overall assessment

The codebase is in solid shape overall. It has a clear layered architecture, strict TypeScript settings, good schema validation, and better-than-average test coverage for a project of this size. I did not find evidence of broad quality regressions in the current tree.

The main concerns are not style or organization problems; they are a handful of correctness gaps where the current behavior does not match the apparent API contract. The biggest issues are around collection scoping, backup/restore consistency, and one retention-path edge case.

## Strengths

- Clear separation between transport, tools, pipeline, storage, search, health, and backup layers.
- Good use of Zod at API boundaries and structured error envelopes.
- Strong baseline checks: typecheck, lint, tests, and build are all green.
- The storage layer makes a real effort to preserve consistency across SQLite and Qdrant, including rollback behavior and vector sync tracking.
- Tests cover most major subsystems instead of concentrating only on utilities.

## Priority findings

### 1. High: semantic and hybrid search silently collapse to the `general` collection when `collection` is omitted

Why it matters:
The public API treats `collection` as optional, which strongly suggests namespace-wide search when it is omitted. Fulltext search follows that model, but semantic and hybrid search do not.

Evidence:
- `SearchService` passes the optional `collection` through to Qdrant in both semantic and hybrid search paths: `src/search/index.ts:68-84`, `src/search/index.ts:118-123`
- `QdrantStore.search()` replaces an omitted collection with `'general'`: `src/storage/qdrant.ts:126-160`
- Fulltext search, by contrast, only applies a collection filter when one is provided: `src/storage/sqlite.ts:469-498`

Impact:
- `search` and `recall` can miss data stored in non-`general` collections.
- Hybrid ranking becomes inconsistent because fulltext can see the full namespace while semantic search only sees one collection.

Recommendation:
- Either fan semantic search out across all namespace collections when `collection` is omitted, or redesign vector storage so a namespace can be searched as a whole.
- Add regression tests for omitted-collection behavior in semantic, hybrid, and recall flows.

### 2. High: exact deduplication is namespace-scoped, not collection-scoped

Why it matters:
Collections appear to be a first-class isolation boundary for memories, but exact dedup ignores that boundary. The same memory content cannot be stored twice in different collections within the same namespace, even though near-dedup logic is collection-aware.

Evidence:
- The write pipeline performs exact dedup with `getMemoryByChecksum(input.namespace, checksum)`: `src/pipeline/index.ts:107-116`
- SQLite lookup only filters on `namespace` and `checksum`, not `collection`: `src/storage/sqlite.ts:413-422`
- Near-dedup uses `searchSimilar()` with the requested collection: `src/pipeline/index.ts:131-136`

Impact:
- Users can get unexpected `NOOP` results when intentionally storing the same fact in multiple collections.
- Exact dedup and semantic dedup follow different scoping rules, which is hard to reason about and likely surprising.

Recommendation:
- Decide whether collections are true write boundaries.
- If they are, include `collection` in exact dedup lookup.
- If they are not, document that clearly and make near-dedup follow the same scope.

### 3. High: backup and restore only preserve SQLite state, not Qdrant vector state

Why it matters:
The application depends on SQLite and Qdrant together, but backups only serialize SQLite. After restore, metadata may say the system is healthy enough to use while Qdrant is stale, incomplete, or out of sync with the restored database.

Evidence:
- Backup creation serializes `this.storage.sqlite.exportData()` into the `.bhgb` artifact: `src/backup/index.ts:23-48`
- Restore writes the SQLite database back and reloads SQLite only: `src/backup/index.ts:76-131`
- `QdrantStore` has a `createSnapshot()` helper, but it is not used by backup flow: `src/storage/qdrant.ts:222-229`

Impact:
- Semantic search, similarity dedup, and vector-backed features can become inconsistent after restore.
- Restoring to an older SQLite snapshot can reference memories whose vectors were deleted or overwrite metadata for vectors that still exist in Qdrant.

Recommendation:
- Treat backup/restore as a dual-store operation.
- Either include Qdrant snapshots in the backup artifact or add a full vector reindex/rebuild step after restore.
- If restore cannot restore Qdrant, explicitly mark restored memories as unsynced and surface that state clearly.

### 4. Medium: disabling sliding-window expiry appears to clear `expires_at` on access

Why it matters:
`sliding_window_enabled = false` should stop extending TTLs, not remove expiry entirely. The current flow appears to convert "do not extend" into "set expiry to null."

Evidence:
- `MemoryLifecycleService.extendExpiry()` returns `null` when sliding-window extension is disabled: `src/domain/lifecycle.ts:122-125`
- `SearchService.buildAccessUpdate()` turns that into `expires_at: null`: `src/search/index.ts:219-237`
- `recordAccessBatch()` writes any provided `expires_at` value back to SQLite, including `null`: `src/storage/sqlite.ts:570-593`

Impact:
- Accessing a memory through search can make a time-bounded memory non-expiring when sliding windows are disabled.
- This is a config-sensitive correctness bug that may go unnoticed in default settings.

Recommendation:
- Distinguish "no expiry change" from "explicitly clear expiry."
- Returning `undefined` instead of `null` from the non-sliding path would be one straightforward fix.
- Add tests for `sliding_window_enabled = false`.

### 5. Medium: `collection://{name}` resource truncates before filtering

Why it matters:
The collection resource should show memories in that collection, but the implementation only grabs the first `50` memories in the namespace and filters that in memory.

Evidence:
- `ResourceHandler.handleCollection()` calls `listMemories(namespace, 50)` and then filters by `collection`: `src/resources/index.ts:225-238`

Impact:
- Collections can look incomplete if relevant memories are older than the newest `50` namespace entries.
- The resource is effectively "newest 50 memories in the namespace that happen to be in this collection," not "this collection."

Recommendation:
- Add a storage query that lists memories by collection directly, ideally with pagination.
- Add resource tests for collections with more than 50 namespace records and mixed collection membership.

## Testing gaps worth addressing

The test suite is healthy, but the highest-risk behaviors above are not well protected by regression tests.

Examples:
- Search tests cover passing an explicit collection, but not the omitted-collection semantic/hybrid behavior: `src/search/index.test.ts:72-104`
- I did not find coverage for cross-collection exact dedup.
- I did not find coverage for restore rehydrating vector state.
- I did not find coverage for the `sliding_window_enabled = false` access path.
- I did not find coverage for `collection://{name}` returning complete results.

## Recommended next steps

1. Fix collection scoping first. That is the most likely source of user-visible "missing data" bugs.
2. Decide and document the intended collection semantics for deduplication.
3. Make backup/restore explicitly dual-store safe or explicitly degraded with a required reindex step.
4. Add regression tests for the omitted-collection, restore, and non-sliding expiry paths.

## Final verdict

This is a well-structured codebase with good engineering hygiene and a green baseline, but it still has a few important semantic mismatches at subsystem boundaries. I would be comfortable iterating on it, but I would fix the collection-search and backup/restore issues before calling the storage model fully production-safe.
