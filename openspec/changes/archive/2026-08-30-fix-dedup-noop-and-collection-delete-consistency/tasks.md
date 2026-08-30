## 1. Write Pipeline NOOP Correctness

- [x] 1.1 Add an explicit `NOOP` branch in `WritePipeline.decide` that returns existing record metadata without writes.
- [x] 1.2 Add defensive handling for missing `NOOP` target ids (return internal error).
- [x] 1.3 Add/extend tests covering `NOOP` classification, response shape, and no-mutation guarantees.

## 2. Collection Deletion Semantics

- [x] 2.1 Extend collection delete input schema/tool API to support `force` semantics.
- [x] 2.2 Add store methods to count and delete memories by `(namespace, collection)`.
- [x] 2.3 Implement guarded delete flow: reject non-empty delete without force.
- [x] 2.4 Implement forced cascade delete across SQLite memories, Qdrant collection, and collection metadata (metadata last).
- [x] 2.5 Return deterministic delete result payload including deleted memory count.

## 3. Validation and Observability

- [x] 3.1 Add tests for empty delete, non-empty non-force conflict, and forced cascade success.
- [x] 3.2 Ensure audit/metrics behavior remains consistent for collection and memory deletions.
- [x] 3.3 Update documentation/examples for new collection delete behavior.
