## 1. Storage API Encapsulation

- [x] 1.1 Add typed SQLite store method(s) for retention stale-candidate lookup.
- [x] 1.2 Add tests for new store method behavior and edge cases.

## 2. Retention Service Refactor

- [x] 2.1 Replace private DB access in `RetentionService` with typed store methods.
- [x] 2.2 Remove `as any` usage and compile-time boundary violations.

## 3. Regression Validation

- [x] 3.1 Add/extend retention tests verifying stale-marked counts remain unchanged.
- [x] 3.2 Run lint/type checks and retention tests to confirm no behavior regressions.
