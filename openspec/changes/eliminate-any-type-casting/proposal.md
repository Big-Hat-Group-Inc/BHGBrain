## Why

The codebase contains 15 instances of `as any` casting, identified in codereview2.md. The most structurally significant are in `src/search/index.ts`, where runtime feature detection (`typeof (this.storage.sqlite as any).getMemoriesByIds === 'function'`) is used to branch between batch and fallback hydration paths. This pattern bypasses TypeScript's type system entirely, suppresses IDE tooling, and makes it impossible to statically verify that required methods exist on the SQLite storage interface. SQL parameter arrays also use `as any[]` for dynamic binding. Additional `as any` casts exist in domain/tool code for optional property access patterns.

The correct fix is not defensive casting — it is defining interfaces that reflect what the code actually requires.

## What Changes

- Extend the `SqliteStorage` interface (or its declared type) to include `getMemoriesByIds`, `recordAccessBatch`, `recordAccess`, and `touchMemory` as first-class typed members, eliminating the feature-detection guards in `search/index.ts`.
- Introduce a typed SQL parameter helper (`SqlParams` or similar) to replace `as any[]` in query bindings.
- Audit all remaining `as any` instances and replace each with a targeted interface, discriminated union, or type predicate.
- After elimination, enforce `@typescript-eslint/no-explicit-any` at `error` level in ESLint config to prevent recurrence.

## Capabilities

### New Capabilities
- `typed-storage-interface`: `SqliteStorage` declares all method signatures that search, retention, and pipeline code depend on, enabling compile-time verification.
- `typed-sql-parameters`: SQL parameter arrays are typed via a dedicated helper type rather than cast.

### Modified Capabilities
- `search-read-hydration-efficiency`: Hydration path selection becomes a static interface dispatch, not a runtime typeof check.

## Impact

- `src/search/index.ts` — Remove all `as any` feature detection; dispatch directly against typed interface.
- `src/storage/sqlite.ts` — Add missing method signatures to exported interface/class type.
- `src/domain/*`, `src/tools/*`, `src/pipeline/*` — Targeted replacements for remaining cast instances.
- `eslint.config.*` — Add `@typescript-eslint/no-explicit-any: error` rule.
- No runtime behavior change; this is a type-layer cleanup with compile-time enforcement added.
