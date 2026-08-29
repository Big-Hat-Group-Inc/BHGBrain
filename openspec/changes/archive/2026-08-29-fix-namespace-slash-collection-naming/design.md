## Context

`QdrantStore.collectionName(namespace, collection)` returns `${COLLECTION_PREFIX}${namespace}_${collection}` and is the single source of truth used by every read/write/delete/snapshot path in `src/storage/qdrant.ts`. A second, independent site (`src/storage/qdrant.ts:229`) reconstructs a *prefix* — `${COLLECTION_PREFIX}${namespace}_` — and does a plain `String.startsWith` scan over `listAllCollections()` to fan out across all of a namespace's collections when `collection` is omitted (added by `fix-collection-scope-consistency`).

Both call shapes silently depend on an invariant that has held only by accident: raw `namespace` and `collection` values can never contain `_` (their Zod patterns only allow `[a-zA-Z0-9-]`/`[a-zA-Z0-9/-]`), so the first bare `_` immediately after the namespace substring is *always* the intended namespace/collection separator, and one namespace's encoded form can never become a false-positive prefix match for another's. Introducing `/` as a legal namespace character breaks this the moment it's naively substituted with anything involving `_`: e.g. namespace `"a"` and namespace `"a/b"` both start with `"a"`, so if `/` were encoded as `_` (or as an escape sequence built from `_`), `"a/b"`'s collection name would false-positive match the prefix scan for namespace `"a"`, silently leaking one namespace's data into another's search results. That collision must be designed out explicitly — the same root cause that broke `remember` would otherwise re-emerge one layer up.

## Goals / Non-Goals

**Goals:**
- Make any namespace/collection pair that passes the existing Zod schemas a valid Qdrant collection name, with no `INTERNAL` errors.
- Guarantee the encoding is injective across the full valid input space (`[a-zA-Z0-9/-]{1,200}`) — no two distinct valid namespaces ever resolve to the same Qdrant collection name.
- Guarantee the namespace-prefix scan (omitted-`collection` fan-out) cannot false-positive match a different namespace's collections.
- Turn any remaining Qdrant-side collection-name rejection into a clear `INVALID_INPUT`/`CONFLICT` error instead of a bare `INTERNAL`.
- Zero data migration: no namespace containing `/` has ever successfully written to Qdrant, so there is nothing on disk to reconcile.

**Non-Goals:**
- Changing the public `namespace`/`collection` Zod patterns in `src/tools/schemas.ts` (they already correctly describe the desired input space; the bug is purely in how that input is turned into a Qdrant collection name).
- A general-purpose reversible codec that can recover the exact original namespace string from a Qdrant collection name — nothing in the codebase needs that today; only forward encoding and safe prefix-matching are required.
- Repacking existing Qdrant collections into a different layout.

## Decisions

1. **Introduce one shared `encodeNamespaceSegment(namespace)` helper in `src/storage/qdrant.ts`, used by both `collectionName()` and the prefix-scan site.**
   - Decision: replace every `/` in the raw namespace with a single reserved substitution character that is (a) accepted by Qdrant in collection names, and (b) never equal to `_` — the character already load-bearing as the namespace/collection joiner — and (c) not already a legal raw-namespace/collection character (so the mapping stays injective: no valid raw namespace already contains the substitute, so encoding can't make two different raw namespaces collide).
   - Rationale: because raw namespaces can never contain `_` (Zod-enforced) and the substitution character is likewise excluded from the raw charset by construction, the existing "first bare `_` after the encoded namespace is the true separator" invariant that the prefix scan already relies on is preserved unchanged — we don't need a new escaping scheme, a length-prefix scheme, or a decode path, just a substitution character disjoint from `_` and from `[a-zA-Z0-9-]`.
   - Candidate character: verify against Qdrant's collection-naming constraints during implementation (task 1 below) and pick the first of `.`, `~`, `!` that Qdrant accepts; fall back to a documented multi-char marker (e.g. a literal string unlikely to collide, `~s~`) only if no single safe character exists. Record the final choice and the verification method (live/dev Qdrant call or authoritative docs) directly in the helper's code comment so the invariant it relies on stays legible.
   - Alternative considered: encode `/` as `__` (double underscore). Rejected — reintroduces `_` into the encoded namespace, which reopens exactly the false-positive-prefix collision described in Context.
   - Alternative considered: percent-encode (`%2F`) as in URL escaping. Rejected without first confirming Qdrant accepts `%` in collection names; adds a decode step nothing in the codebase needs; no simpler than a direct substitution.

2. **Apply the same helper to `collection` values too, not just `namespace`.**
   - Decision: even though `collection`'s current Zod pattern doesn't allow `/`, route it through the same sanitization step for defense in depth and to keep one clear rule ("anything used inside a Qdrant collection name goes through this helper") rather than two subtly different ones.
   - Rationale: avoids a second latent bug if `collection`'s pattern is ever loosened later, and keeps `collectionName()` simple to reason about.

3. **Wrap the Qdrant-call boundary so a collection-name-shaped rejection surfaces as `INVALID_INPUT`, not `INTERNAL`.**
   - Decision: at the point(s) in `qdrant.ts` that catch Qdrant client errors around collection creation/access, detect a collection-name-validation failure (by response status/message, following whatever pattern the existing catch blocks in `ensureCollection`/`delete`/`deleteCollection` already use to distinguish "not found" from other failures) and re-throw via `invalidInput()`/`conflict()` from `src/errors/index.ts` instead of letting it fall through to the generic `internal()` path.
   - Rationale: this is defense in depth for whatever edge case the encoding in Decision 1 doesn't anticipate (e.g. a future Qdrant version tightening its own naming rules) — callers should get an actionable error, never a bare retryable `INTERNAL` for what is fundamentally a bad-input problem.
   - Alternative considered: rely solely on the encoding fix and skip the error-mapping improvement. Rejected — the original bug report is explicitly about a *misleading* error, not just a failing one; fixing only the happy path leaves the diagnostic problem unaddressed for the next similar edge case.

## Risks / Trade-offs

- [Wrong choice of substitution character turns out to be Qdrant-unsafe after all, or collides with something else] -> Mitigation: task 1 explicitly verifies the chosen character against a live/dev Qdrant instance (per this repo's WSL2 Qdrant/Docker verification approach) before the encoding is finalized, and the unit tests in task 3 assert the injectivity/no-false-prefix properties directly rather than trusting the character choice by inspection alone.
- [Encoded collection names become harder to read/debug in Qdrant's own dashboard] -> Mitigation: acceptable trade-off — these are internal identifiers already prefixed and underscore-joined; readability was never a guarantee, and correctness takes priority.
- [Missing one of the `collectionName()` call sites when applying the fix] -> Mitigation: the helper is a single function already called from every site (confirmed via `grep` across `qdrant.ts`); routing all of them through the same `encodeNamespaceSegment` call inside `collectionName()` itself (rather than at each call site) makes it structurally impossible to miss one.

## Migration Plan

1. Add `encodeNamespaceSegment()` (or equivalent) to `src/storage/qdrant.ts`, verify the chosen substitution character against Qdrant's collection-naming rules, and route `collectionName()` through it.
2. Update the namespace-wide prefix-scan site (`src/storage/qdrant.ts:229`) to build its prefix from the same encoding helper.
3. Tighten the Qdrant-error-catch boundary to map collection-name-shaped rejections to `INVALID_INPUT`/`CONFLICT` instead of `INTERNAL`.
4. Add unit tests for the encoding helper (injectivity across representative inputs, no false-positive prefix matches between a namespace and a longer namespace that starts with it) and an integration test exercising `remember`/`recall`/`search`/`collections` with a slash-containing namespace end to end.
5. Run `npm run lint && npm test` to confirm no regression in the existing `fix-collection-scope-consistency` fan-out behavior.

## Open Questions

- Which exact substitution character Qdrant accepts cleanly — resolve empirically during implementation (task 1) rather than guessing here.
