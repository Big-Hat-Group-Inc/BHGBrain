## Why

`remember` (and every other tool that accepts `namespace`) throws a generic `INTERNAL` error whenever `namespace` contains a `/`, even though the input schema's own pattern — `^[a-zA-Z0-9/-]{1,200}$`, documented at README.md:1177 and README.md:2902 as "alphanumeric characters, hyphens, and forward slashes" — explicitly permits it. Reproduced live during MCP tool verification testing (2026-08-29): `remember({content: "...", namespace: "test/mcp-verify"})` fails every time; `namespace: "mcp-verify"` (no slash) succeeds.

Root cause: `QdrantStore.collectionName()` (`src/storage/qdrant.ts:47-48`) builds the physical Qdrant collection name as `${COLLECTION_PREFIX}${namespace}_${collection}`. Qdrant collection names are used as literal URL path segments, so a raw `/` splits the path and the request fails; that failure bubbles up through `executeWithBreaker`/the tool dispatcher as an undifferentiated `INTERNAL` error instead of a clear validation message. Every code path that resolves a namespace to a Qdrant collection shares this one helper (`ensureCollection`, `upsert`, `delete`, `deleteMany`, `search`, `getCollectionInfo`, `compact`, `deleteCollection`, `createSnapshot`, `scrollAll`), plus a second, independent string-prefix scan (`src/storage/qdrant.ts:229`) used to fan out across a namespace's collections when `collection` is omitted — so any fix must cover both call shapes, not just the single-collection case.

This silently breaks the hierarchical namespace convention (e.g. `team/project`, `user/repo`) that the schema's own pattern is clearly designed to support, and today it fails with zero indication of *why* — a caller sees `INTERNAL`/`retryable: true` and has no reason to suspect the namespace value itself.

## What Changes

- Add a single, shared encoding step that makes any schema-valid `namespace` (and `collection`) value safe to embed in a Qdrant collection name, used by `collectionName()` and by the namespace-wide collection prefix scan alike.
- Choose the encoding so it cannot collide: two different valid namespaces must never encode to the same Qdrant collection name, and encoding one namespace must never make it a false-positive prefix match for a different, longer namespace during the prefix scan.
- Keep the fix additive/non-breaking: no pre-existing Qdrant collection was ever created for a slash-containing namespace (that path always errored), so there is nothing to migrate.
- Improve error clarity as defense in depth: if a namespace/collection pair still can't be turned into a valid Qdrant collection name (or Qdrant rejects it for any other reason tied to the name itself), surface `INVALID_INPUT`/`CONFLICT` per `src/errors/index.ts`'s existing taxonomy instead of a bare `INTERNAL`.
- Add regression coverage: a unit test for the new encoding helper (collision/prefix-safety cases) and an integration-level test exercising `remember`/`recall`/`search`/`collections` end-to-end with a slash-containing namespace.

## Capabilities

### New Capabilities
- `namespace-collection-encoding`: defines how namespace/collection values are made safe for use as Qdrant collection names, and the guarantees (no cross-namespace collisions, no false-positive prefix matches) that encoding must uphold.

### Modified Capabilities

## Impact

- Affected code: `src/storage/qdrant.ts` (`collectionName`, the namespace-prefix scan, and their shared call sites), `src/errors/index.ts` usage at the Qdrant call boundary, and related tests (`src/storage/qdrant.test.ts`).
- API behavior: `remember`, `recall`, `search`, `tag`, `forget`, `relate`, `revisions`, `review`, `feedback`, `collections`, `consolidate` — anything that resolves a namespace against Qdrant — starts succeeding for slash-containing namespaces instead of throwing `INTERNAL`.
- Data behavior: none for existing data; this only unlocks a previously-always-failing input shape.
