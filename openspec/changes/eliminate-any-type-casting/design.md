## Context

`src/search/index.ts` uses three tiers of fallback to hydrate search results:
1. `getMemoriesByIds` (batch, preferred) — checked via `typeof (this.storage.sqlite as any).getMemoriesByIds === 'function'`
2. `getMemoryById` (per-row loop, N+1 fallback) — produces `(mem: any)` typed results
3. `touchMemory` (minimal update fallback for `recordAccess`)

This defensive structure was appropriate during iterative development when the storage interface was unstable. The batch methods (`getMemoriesByIds`, `recordAccessBatch`) are now implemented and stable, making the fallback tiers and their `as any` guards unnecessary. The `optimize-read-path-memory-efficiency` openspec requires `getMemoriesByIds` to always exist — this openspec enforces that at the type layer.

Other cast sites include:
- `as any[]` for SQLite parameter binding (widespread in `storage/sqlite.ts`)
- Optional property access patterns in domain/tool code (e.g., `(obj as any).someOptionalProp`)

## Goals / Non-Goals

**Goals:**
- Make `SqliteStorage` interface complete so all consumers compile without casts.
- Eliminate `as any[]` in SQL parameter arrays via a named type alias.
- Replace `as any` optional-property accesses with discriminated unions or type predicates.
- Add ESLint enforcement to prevent new `as any` introductions.

**Non-Goals:**
- Migrating to a different ORM or query builder.
- Rewriting the feature-detection pattern as a compatibility shim for old storage implementations.
- Changing runtime behavior of any method.

## Decisions

### Decision: Extend interface rather than introduce adapter

**Why:** The fallback tiers exist only because the methods weren't declared in the interface. Adding declarations is the minimal correct fix. An adapter layer would add indirection without benefit.

**Alternative considered:** Runtime adapter that wraps old storage and provides missing methods. Rejected — there is no old storage to support; all methods already exist in the implementation.

### Decision: `SqlParams` type alias over `unknown[]`

**Why:** SQLite parameter binding accepts `string | number | null | Uint8Array` per the driver spec. A union type is more precise than `any[]` and prevents accidentally passing objects. `unknown[]` is safer than `any[]` but still too permissive.

**Alternative considered:** Keep `any[]` for DX convenience. Rejected — `no-explicit-any` enforcement would block this anyway.

### Decision: ESLint `error` (not `warn`) for `no-explicit-any`

**Why:** Warnings are ignored in CI unless configured to fail. `error` ensures no new casts land without explicit `// eslint-disable` comments, which serve as documentation of intentional escapes.

## Risks / Trade-offs

- **[Risk] Hidden fallback paths mask absent methods in old storage versions** → Mitigation: fallback tiers are removed simultaneously with method declarations, so both must be present together. The `optimize-read-path-memory-efficiency` openspec already requires batch methods to exist.
- **[Risk] ESLint error level breaks existing CI** → Mitigation: clean up all existing cast sites in the same PR before enabling the rule.
