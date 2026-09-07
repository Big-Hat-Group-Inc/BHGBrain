## Why

Several operations scale with the accumulated corpus rather than a request limit: vector scrolling buffers entire collections, distillation clusters quadratically, imports can generate huge outbound fan-out, FTS deletion scans the whole index, and recovery/response paths can monopolize the event loop.

## What Changes

- Add paged/streaming Qdrant traversal with payload projection and migrate hydration, repair, drift detection, and distillation callers.
- Bound distillation candidates and compute similarity with precomputed norms and cooperative yielding.
- Move FTS maintenance to seekable row identifiers and add indexes/keyset pagination for hot SQLite predicates.
- Reuse batched transactional hydration for `repair --from-qdrant` and preserve recovered lifecycle metadata.
- Cap import chunks and per-chunk content, batch provider work, and return explicit progress/failure details.
- Add bounded concurrency to consolidation discovery and enforce response character budgets across tools/resources.

## Capabilities

### New Capabilities
- `corpus-scale-work-bounds`: Defines memory, CPU, concurrency, pagination, and response-size bounds for corpus-driven workflows.

### Modified Capabilities

## Impact

- Affected code: `src/storage/qdrant.ts`, `src/storage/sqlite.ts`, `src/pipeline/distillation*.ts`, `src/pipeline/parser.ts`, `src/tools/import.ts`, `src/tools/index.ts`, `src/resources/index.ts`, configuration, and performance/integration tests.
- Audit coverage: F17, F25, F26, F28, F36, F80, and F95.
- Runtime behavior: large operations become paged, interruptible, and explicitly bounded.
