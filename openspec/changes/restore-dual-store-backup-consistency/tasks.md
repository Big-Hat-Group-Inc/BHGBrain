## 1. Restore consistency model

- [x] 1.1 Extend restore and health contracts to represent metadata activation separately from vector reconciliation state.
- [x] 1.2 Add storage and reconciliation helpers that can mark restored memories unsynced and iterate restored SQLite rows for vector rebuild.

## 2. Dual-store restore implementation

- [x] 2.1 Update restore flow so activating restored SQLite state does not silently trust pre-existing Qdrant vectors.
- [x] 2.2 Implement post-restore vector reconciliation that re-upserts restored memories into the correct Qdrant collections and preserves explicit degraded behavior when embeddings are unavailable.

## 3. Validation

- [x] 3.1 Add regression tests for restore with stale vector state, successful reconciliation, and pending/degraded behavior when embeddings are unavailable.
- [x] 3.2 Run `npm run lint`, `npm test`, and `npm run build` to verify restore readiness and health semantics.
