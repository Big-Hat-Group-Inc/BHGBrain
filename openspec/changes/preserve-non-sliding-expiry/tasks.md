## 1. Expiry update contract

- [x] 1.1 Update lifecycle and access-update types so “preserve expiry” is represented separately from “clear expiry”. _(impl 2026-06-05: `MemoryLifecycleService.nextExpiryForAccess` returns tri-state `string | null | undefined`, `src/domain/lifecycle.ts`.)_
- [x] 1.2 Update read-path access update assembly so unchanged-tier reads preserve the existing expiry while promotion still applies the promoted tier lifecycle policy. _(`buildAccessUpdate`, `src/search/index.ts`.)_

## 2. Storage and regression coverage

- [x] 2.1 Update SQLite access update helpers to honor no-change expiry inputs without writing `null`. _(verified already correct: `recordAccessBatch` only writes `expires_at` when `!== undefined`, `src/storage/sqlite.ts`.)_
- [x] 2.2 Add regression tests for unchanged-tier access and promotion behavior when `sliding_window_enabled` is `false`. _(`src/domain/lifecycle.test.ts`, `src/search/index.test.ts`.)_

## 3. Validation

- [x] 3.1 Run `npm run lint`, `npm test`, and `npm run build` to verify the retention fix does not regress search or lifecycle behavior. _(2026-06-05: lint clean, 241 tests pass, build OK.)_
