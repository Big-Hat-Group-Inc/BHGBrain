## 1. Audit All `as any` Instances

- [x] 1.1 Run `grep -rn "as any" src/` and produce a list of all cast sites with file + line
- [x] 1.2 Categorize each into: (a) feature detection, (b) SQL parameters, (c) optional property access, (d) other
- [x] 1.3 For each category, identify the minimal interface change that eliminates the cast

## 2. Extend `SqliteStorage` Interface

- [x] 2.1 Add `getMemoriesByIds(ids: string[]): Memory[]` to the `SqliteStorage` interface in `src/storage/sqlite.ts`
- [x] 2.2 Add `recordAccessBatch(updates: AccessUpdate[]): void` to the interface
- [x] 2.3 Add `recordAccess(id: string, accessCount: number, lastAccessed: string, expiresAt: string | null | undefined, retentionTier: RetentionTier | undefined, reviewDue: string | null | undefined): void` to the interface
- [x] 2.4 Confirm the existing implementation in `SqliteStorage` satisfies all added signatures without changes
- [x] 2.5 Export `AccessUpdate` type from `src/storage/sqlite.ts` for use by callers

## 3. Refactor `search/index.ts` Feature Detection

- [x] 3.1 Remove the `typeof (this.storage.sqlite as any).getMemoriesByIds === 'function'` guard and call `getMemoriesByIds` directly
- [x] 3.2 Remove the `recordAccessBatch` / `recordAccess` / `touchMemory` fallback chain and call `recordAccessBatch` directly
- [x] 3.3 Replace all `(mem: any)` typed map callbacks with the proper `Memory` type from `src/domain/types.ts`
- [x] 3.4 Confirm `search/index.ts` compiles with zero `as any` and zero TS errors

## 4. Introduce `SqlParams` Type

- [x] 4.1 Add `type SqlParams = (string | number | null | Uint8Array)[]` to `src/storage/sqlite.ts` and export it
- [x] 4.2 Replace all `as any[]` SQL parameter arrays in `src/storage/sqlite.ts` with `SqlParams`
- [x] 4.3 Confirm no remaining `as any[]` in the storage layer

## 5. Remaining Cast Sites

- [x] 5.1 For each remaining `as any` in `src/domain/*`, `src/tools/*`, `src/pipeline/*`: introduce a discriminated union, type predicate, or narrowing check to replace the cast
- [x] 5.2 For any `as any` that is genuinely unavoidable (e.g., third-party library gap), add an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment with a justification note
- [x] 5.3 Confirm zero undecorated `as any` remain in `src/`

## 6. ESLint Enforcement

- [x] 6.1 Add `"@typescript-eslint/no-explicit-any": "error"` to ESLint config
- [x] 6.2 Run `eslint src/` and confirm zero violations (all surviving escapes are decorated with justification comments)
- [x] 6.3 Add ESLint check to CI pipeline (if not already present) so future violations are caught on PR

## 7. Tests and Commit

- [x] 7.1 Run full test suite (`npm test`) and confirm no regressions
- [x] 7.2 Run TypeScript compiler (`tsc --noEmit`) and confirm zero errors
- [x] 7.3 Commit with message: `refactor: eliminate as-any casting with typed interfaces and SqlParams (codereview2)`
- [x] 7.4 Push to active branch
