## Why

**Live production bug (BIG-928):** on the deployed server, `remember` only works for the default `global/general` pair. Any write to another namespace or collection — `profile`, `projects/shipwin32`, or a new collection in `global` — fails with `{"code":"INTERNAL","message":"An unexpected error occurred","retryable":true}`. `bootstrap submit` writes to `profile`, so bootstrap cannot be completed at all, and agents filing notes under a project namespace silently fall back to `general`.

Root cause: before writing, the pipeline's dedup step calls `QdrantStore.searchSimilar` against the target Qdrant collection, which does not exist until the first upsert creates it. Qdrant answers `404`, and `searchSimilar` is meant to treat that as "no near-duplicates" via `QdrantStore.isNotFoundError`. That check only inspected the error's `message`, expecting Qdrant's text ("Collection `x` doesn't exist!"). The real `@qdrant/js-client-rest@1.19` client surfaces a non-2xx response as the fetcher's `ApiError`, whose `message` is only the HTTP status text (`"Not Found"`); Qdrant's explanation is in `data.status.error`. Every genuine missing-collection 404 was therefore misclassified as a hard failure, rethrown raw, and flattened by `handleTool` into the generic retryable INTERNAL envelope. `global/general` worked only because its Qdrant collection already existed.

The unit tests never caught it because every missing-collection fake put the Qdrant text in `.message` — a shape the real client never produces. The same misclassification made `healthCheck` report unhealthy on a store whose default collection does not exist yet, and made an explicit-collection `search`/`recall` of a never-written collection throw instead of returning nothing.

Secondary defect: a permanent upstream rejection reached callers as `retryable: true`, inviting endless retries of a call that can never succeed.

## What Changes

- `QdrantStore.isNotFoundError` reads Qdrant's own error text from `data.status.error` (new exported helper `qdrantErrorDetail`) in addition to `message`. The `bound-qdrant-http-runtime` guarantee is preserved: a 404 whose body does not name a missing collection/point (a proxy/ingress page, a wrong base URL) is still a real failure.
- `handleTool` reclassifies an otherwise-unclassified error carrying a definite HTTP 4xx (other than `408`/`429`) into a non-retryable `INTERNAL` envelope that names only the status (`classifyPermanentDependencyError`); the raw upstream error is kept as `cause` for the server log and never echoed to the caller.
- `FakeQdrantClient` (the eval harness transport) throws the real `ApiError` shape for a missing collection, so the eval and any test built on it exercise production's classification.
- Regression tests drive the real Qdrant client against an in-process Qdrant stand-in, and run `remember`/`bootstrap` end-to-end through `handleTool` → `WritePipeline` → `StorageManager` → `QdrantStore`.
- README (all five languages) documents when an `INTERNAL` error is `retryable: false`.

## Capabilities

### New Capabilities
- `vector-store-error-classification`: how the Qdrant adapter recognizes a missing collection/point from the real client's error shape, and how a permanent upstream rejection is reported to tool callers.

### Modified Capabilities

## Impact

- Affected code: `src/storage/qdrant.ts` (`isNotFoundError`, new `qdrantErrorDetail`), `src/errors/index.ts` (new `classifyPermanentDependencyError`), `src/tools/index.ts` (`handleTool` catch), `src/eval/fake-qdrant-client.ts`; tests in `src/storage/qdrant.test.ts` and new `src/tools/non-default-collection-writes.test.ts`.
- API behavior: first writes to any new namespace/collection succeed; `bootstrap submit` works; a raw upstream 4xx is now `retryable: false`. No schema, tool, resource, or prompt surface changes.
- Health: `qdrant` health no longer reports unhealthy just because the default collection has not been created yet.
- Operations: the deployed `bhgbrain-vm` must be redeployed; the orphan empty `projects/shipwin32` collection row (created by `collections create`, which writes SQLite only) and the two bootstrap answers stored in `global/general` as a workaround need a manual cleanup afterwards.
