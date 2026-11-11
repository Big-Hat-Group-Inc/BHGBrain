## 1. Missing-collection classification

- [x] 1.1 Add `qdrantErrorDetail(err)` to `src/storage/qdrant.ts` (reads `data.status.error`) and make `isNotFoundError` check it alongside `message`, keeping the 404 + "names a missing collection/point" rule. Correct the misleading comment about the client's error shape.
- [x] 1.2 Make `FakeQdrantClient` throw the real `ApiError` shape (`message: 'Not Found'`, `status: 404`, `data.status.error`).

## 2. Permanent-failure classification

- [x] 2.1 Add `classifyPermanentDependencyError` to `src/errors/index.ts` (4xx except 408/429 → non-retryable `INTERNAL`, status-only message, original kept as `cause`) and apply it in `handleTool`'s catch after the existing classifiers.

## 3. Tests

- [x] 3.1 Real-client tests in `src/storage/qdrant.test.ts` against an in-process Qdrant stand-in: missing collection → no near-duplicates for a namespace without `/`, with `/`, and a new collection in `global`; dedup-then-upsert into a new collection; health with no default collection; explicit-collection `search` of a missing collection; route-wide HTML 404 still fails. _(Confirmed failing on the pre-fix code: 6 of 7 failed with the raw `ApiError`.)_
- [x] 3.2 End-to-end `handleTool` tests (`src/tools/non-default-collection-writes.test.ts`): `remember` into the three new targets, into a `collections create`-only collection, dedup on a second write, and `bootstrap submit` + `status` on `profile`. _(All 6 write scenarios fail with the `qdrant.ts` fix reverted.)_
- [x] 3.3 `handleTool` tests: upstream 400 → `retryable: false` without leaking the body; 408/429/503 keep the retryable fallback.
- [x] 3.4 `npm run lint` clean; `npm test` shows no new failures. _(22 pre-existing failures — `EPERM … fsync` in backup/config/sqlite-activation suites on this Windows sandbox — are identical on clean `main`.)_

## 4. Docs

- [x] 4.1 Document when `INTERNAL` is `retryable: false` under the error envelope in `README.md` and the four translated READMEs.

## 5. Deployment and data cleanup (bhgbrain-vm)

- [ ] 5.1 Redeploy `bhgbrain-vm` with this fix and re-run BIG-928's reproduction table (tests 2–4 and `bootstrap submit` must succeed).
- [ ] 5.2 Delete the empty `projects/shipwin32` collection row (`collections delete`, namespace `projects`, name `shipwin32`), or reuse it now that writes into it succeed.
- [ ] 5.3 (Optional) Re-file the workaround bootstrap memories `f2870bb6-…` (section 1) and `eb2d6720-…` (section 2) from `global/general` into `profile` via `bootstrap submit`, then `forget` the originals, so bootstrap resumes at section 3.
