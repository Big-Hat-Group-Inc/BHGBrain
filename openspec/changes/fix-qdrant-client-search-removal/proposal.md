# Fix vector-store read path broken by @qdrant/js-client-rest 1.19

## Why

Every semantic read is dead on a fresh install. `package.json:51` declares
`"@qdrant/js-client-rest": "^1.13.0"`. That caret range now resolves to `1.19.0`, which
**removed `QdrantClient.search()`** in favour of `QdrantClient.query()`. The code still calls
`this.client.search(...)` at `src/storage/qdrant.ts:170` (namespace fan-out) and
`src/storage/qdrant.ts:204` (`searchSimilar`).

Observed on a clean `npm install -g @kkaminsk/bhgbrain@1.4.1` against Qdrant Cloud
(2026-08-25):

```
recall -> { "code": "INTERNAL",
            "message": "Semantic search failed: vector store unavailable - this.client.search is not a function",
            "retryable": true }
```

`search()` exists in 1.13.0 through 1.18.0 and is absent from 1.19.0, so the declared range
spans both a working and a broken API. Nothing in the repo pins or verifies it.

Three properties make this worse than an ordinary break:

1. **Writes keep succeeding.** `remember` uses `client.upsert()` (`src/storage/qdrant.ts:86`),
   which still exists. Memories are embedded and persisted to Qdrant normally, so the store
   looks correct from the outside while nothing can be read back.
2. **Deduplication fails silently.** `searchSimilar` wraps its call in
   `try { ... } catch { return []; }` (`src/storage/qdrant.ts:203-215`). The missing method is
   swallowed as "no similar vectors", so near-duplicate detection degrades to a permanent no-op
   with no error, no log, and no degraded flag - every write is treated as novel.
3. **The test suite cannot catch it.** `src/storage/qdrant.test.ts:5-8` declares its own
   `MockClient` type with a `search` member and injects it over the real client. The mock
   defines the API surface it is asserting against, so the suite passes identically whether or
   not the installed client still has `search()`.

## What Changes

- Migrate both call sites from the removed `client.search(name, { vector, ... })` to the
  supported `client.query(name, { query: vector, ... })`, including the response-shape change
  from a bare array to `{ points: [...] }`.
- Constrain the `@qdrant/js-client-rest` dependency to a range whose client API the code
  actually targets, so a transitive minor bump cannot silently remove a method the code calls.
- Make `searchSimilar` distinguish "no similar vectors" from "the vector store call failed",
  so a broken read path can no longer masquerade as a successful empty dedup result.
- Bind the test double to the real client type so a future upstream method removal fails
  `npm run lint` instead of passing a green suite.

## Capabilities

### New Capabilities

- `vector-store-client-compatibility`: the vector-store adapter SHALL only call Qdrant client
  methods guaranteed by the declared dependency range, SHALL surface vector-store call failures
  rather than coercing them to empty results, and SHALL verify its test doubles against the real
  client type.

### Modified Capabilities

(none)

## Impact

- Affected code: `src/storage/qdrant.ts` (`search`, `searchSimilar`), `package.json`
  (dependency range), `src/storage/qdrant.test.ts` (mock typing).
- Affected behavior: `recall`, `search`, and the near-duplicate arm of the write pipeline all
  return correct results again on a fresh install. Exact-dedup and fulltext paths are unchanged.
- Affected specs: adds `vector-store-client-compatibility`.
- Risk: moderate - touches the primary read path. The `query` response is `{ points }` rather
  than an array, so the mapping at `src/storage/qdrant.ts:183-187` and `:212` must be updated in
  lockstep or results become empty rather than erroring.
- Related: `fix-vector-store-health-fidelity` covers why `bhgbrain health` reported
  `qdrant: healthy` throughout this outage.
