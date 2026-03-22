## 1. Expiry update contract

- [ ] 1.1 Update lifecycle and access-update types so “preserve expiry” is represented separately from “clear expiry”.
- [ ] 1.2 Update read-path access update assembly so unchanged-tier reads preserve the existing expiry while promotion still applies the promoted tier lifecycle policy.

## 2. Storage and regression coverage

- [ ] 2.1 Update SQLite access update helpers to honor no-change expiry inputs without writing `null`.
- [ ] 2.2 Add regression tests for unchanged-tier access and promotion behavior when `sliding_window_enabled` is `false`.

## 3. Validation

- [ ] 3.1 Run `npm run lint`, `npm test`, and `npm run build` to verify the retention fix does not regress search or lifecycle behavior.
