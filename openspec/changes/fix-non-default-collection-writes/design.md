## Context

`QdrantStore` treats a missing Qdrant collection/point as an idempotent no-op in several places — `searchSimilar` (the write pipeline's dedup lookup), `search` (explicit-collection queries), `healthCheck`, `delete`, `deleteMany`, `upsert`'s re-ensure retry, `clearManagedCollections`. All of them route through one predicate, `isNotFoundError`. `bound-qdrant-http-runtime` deliberately narrowed that predicate so a bare, route-wide 404 (a reverse proxy's error page, a misconfigured base URL) is never mistaken for "the collection doesn't exist yet".

The narrowed predicate was written against an assumed error shape: its comment states that the real client raises `QdrantClientUnexpectedResponseError` with the response body embedded in `message`. That is not what `@qdrant/js-client-rest@1.19` does. Its middleware (`api-client.js`) only builds `QdrantClientUnexpectedResponseError` for non-2xx statuses that the fetcher did *not* already throw on; a 4xx/5xx is thrown by the fetcher as `ApiError` (`@qdrant/openapi-typescript-fetch`), with `message = response.statusText`, `status`, and the parsed JSON body in `data` — for Qdrant, `{ status: { error: "Not found: Collection `x` doesn't exist!" }, time }`. Confirmed by driving the real client against a local HTTP server returning Qdrant's 404 body.

## Goals / Non-Goals

**Goals:**
- Recognize Qdrant's genuine missing-collection/point 404 from the real client's error shape.
- Keep the `bound-qdrant-http-runtime` guarantee that a non-Qdrant 404 is a real failure.
- Test against the real client, not a hand-built approximation of its errors.
- Stop reporting permanent upstream rejections as retryable.

**Non-Goals:**
- Pre-creating the Qdrant collection when `collections create` runs. With the predicate fixed, the first `remember` creates it lazily exactly as it already does for `general`; making `collections create` touch Qdrant would add a second, failure-prone write path for no functional gain.
- A new `ErrorCode` for dependency failures. Adding one changes the public envelope contract, the strict `isErrorEnvelope` predicate, and every transport/README; the actionable signal callers need is `retryable: false` plus a message naming the HTTP status, which this change delivers inside the existing `INTERNAL` code.
- Wrapping the dual-store write in a compensating transaction (the "orphan collection row" theory in BIG-928). Investigation showed the empty `projects/shipwin32` row came from `collections create`, which only writes SQLite by design; the failing writes threw during dedup, before any SQLite write, so they left nothing behind.

## Decisions

1. **Read Qdrant's message from `data.status.error`, keep the 404 + "names what's missing" rule.**
   - `isNotFoundError` still requires a 404 (numeric `status`/`response.status`, or `(not found)`/`404 ` in the message for the wrapper-error shape), and still requires the text to name a missing collection or point. The only change is *where* it looks for that text: `message` **and** `qdrantErrorDetail(err)` (`data.status.error` when it is a string).
   - A proxy's HTML 404 has no Qdrant-shaped `data`, so `qdrantErrorDetail` returns `''` and the predicate stays false — the route-wide-404 guarantee holds (covered by a real-client test).
   - Alternative considered: treat every `ApiError` 404 from a collection-scoped endpoint as missing-collection. Rejected — it reopens exactly the misconfigured-URL hole `bound-qdrant-http-runtime` closed.

2. **Classify raw upstream 4xx at the `handleTool` boundary.**
   - `classifyPermanentDependencyError` runs after the existing lifecycle/lock classifiers. A non-`BrainError` `Error` with numeric `status` in 400–499, excluding `408` and `429`, becomes `BrainError('INTERNAL', 'An upstream dependency rejected the request (HTTP <status>) …', retryable=false)` with the original error as `cause`.
   - The message never includes the upstream body: Qdrant's text can name internal collection names, and `handleTool`'s existing policy is to never echo raw error text for unclassified errors. The full error (including `data`) still reaches the log via `cause`.
   - 5xx and status-less errors keep the existing generic retryable fallback.

3. **Make the test doubles honest.**
   - New `qdrant.test.ts` block runs `QdrantStore` with a real `QdrantClient` against an in-process HTTP stand-in that returns Qdrant's actual 404 JSON body, a missing collection auto-created on `PUT`, and a route-wide HTML 404 mode.
   - `FakeQdrantClient` now throws `{ message: 'Not Found', status: 404, data: { status: { error } } }`, so the eval harness and the new end-to-end tool tests exercise the same classification production does. The older message-only fakes in `qdrant.test.ts` are left in place; they still pass and document the wrapper-error shape.

## Risks / Trade-offs

- [Another Qdrant client upgrade changes the error shape again] → The real-client tests fail loudly on any such change rather than the fakes masking it.
- [An embedding SDK error with a 4xx `status` now reports `retryable: false`] → Intended: an invalid key or rejected input is equally permanent. 408/429 remain retryable.

## Migration Plan

Code-only fix; no data or schema migration. After merge: redeploy `bhgbrain-vm`, re-run BIG-928's reproduction table, delete the empty `projects/shipwin32` collection row, and optionally move the two workaround bootstrap memories from `global/general` into `profile` (then mark sections 1–2 complete) so bootstrap resumes at section 3.
