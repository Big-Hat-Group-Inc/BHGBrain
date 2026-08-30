## 1. Search Efficiency

- [x] 1.1 Add bulk memory hydration APIs for ranked search results.
- [x] 1.2 Refactor semantic, fulltext, and hybrid search to avoid per-hit SQLite lookups.
- [x] 1.3 Bound access-metadata persistence triggered by read paths.

## 2. Auto-Inject Efficiency

- [x] 2.1 Refactor auto-inject assembly to honor budget while building content.
- [x] 2.2 Avoid loading or concatenating category content that cannot fit in the payload budget.

## 3. Verification

- [x] 3.1 Add tests for ordered bulk hydration.
- [x] 3.2 Add tests for large-category inject payload behavior and truncation metadata.
