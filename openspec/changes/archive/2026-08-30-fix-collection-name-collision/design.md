## Context

`fix-namespace-slash-collection-naming` fixed `namespace` values containing `/` throwing `INTERNAL`, by adding `encodeCollectionNameSegment()` (`/` → `.`) and applying it to both `collectionName()` arguments. Its injectivity argument rested on: "raw input can never contain the substitution character `.`, because neither schema allows it." That's true for `NamespaceSchema` (`^[a-zA-Z0-9/-]{1,200}$`) but was never actually checked for `collection`'s schema, `NameSchema` (`z.string().min(1).max(100)`, `src/domain/schemas.ts:18`) — which allows any character. The assumption silently failed for the one argument it wasn't verified against, and the resulting collision (`collection: "a.b"` == `collection: "a/b"` once encoded) is live on `main` today.

This is the second time an assumption about `namespace`/`collection` charset has caused a real bug in the same function. The design here should close both the immediate hole and the *pattern* — an encoder that's only injective "as long as callers behave" is a latent bug generator.

## Goals / Non-Goals

**Goals:**
- Make `collection: "a.b"` and `collection: "a/b"` (or any other pair of distinct valid `collection` values) always resolve to distinct Qdrant collection names.
- Close the hole at the validation boundary (schema), not just in the encoder, since that's where this codebase's own comments already assumed the guarantee lived.
- Make the encoder itself provably injective independent of what the schema currently allows, so a future schema change (accidental loosening, a new field routed through the same encoder) can't reopen this class of bug silently.
- Apply the same schema fix to `category.name` for consistency, since it shares `NameSchema` and the identical root cause, even though it isn't embedded in a Qdrant collection name today.

**Non-Goals:**
- Migrating or renaming any Qdrant collection that may already exist with a literal `.` in its name — no evidence such a collection exists, and forcing a rename would be a disruptive, unnecessary migration for a hypothetical case. Existing collections keep working; only new `collection`/`category.name` values are validated against the tightened pattern.
- Adding a `collection` payload filter to `QdrantStore.search()` as a second line of defense against collisions. Tempting, but out of scope: once collisions are structurally impossible (this proposal's actual fix), a redundant payload filter adds cost without closing a gap that no longer exists. If a *future* proposal wants defense-in-depth there independent of this one, it can stand on its own.
- Reversible decoding of an encoded collection name back to its original `namespace`/`collection`. As before, nothing in the codebase needs that — only forward injectivity.

## Decisions

1. **Tighten `collection` and `category.name` validation to a slug-like charset that excludes `.` and `/`.**
   - Decision: introduce `COLLECTION_NAME_RE = /^[a-zA-Z0-9-]{1,100}$/` in `src/domain/schemas.ts` and use it for both `collection` (all `NameSchema` call sites currently typed as collection: `remember`, `recall`, `search`, `collections`, `consolidate`) and `category.name`. Keep `NameSchema` itself unused after the swap, or repurpose it only if a genuinely free-text `Name`-shaped field appears later — for now, replace both usages directly.
   - Rationale: every current usage of `NameSchema` is an identifier embedded in a lookup key (Qdrant collection name, SQLite `collections`/`categories` row key) — none is display text. A slug pattern matches `src/storage/qdrant.ts`'s own stated assumption ("alphanumeric/hyphen by convention") and closes the hole where it was actually opened, not just downstream of it.
   - Alternative considered: only tighten `collection`, leave `category.name` alone. Rejected — `category.name` has the identical charset gap and the identical root schema (`NameSchema`); leaving it unfixed just relocates the same class of bug to the day categories are ever used to build an identifier (e.g. a metrics label, an export filename), which is exactly the kind of latent landmine this proposal exists to remove.
   - Alternative considered: keep `collection`/`category.name` permissive and rely solely on the encoder fix (Decision 2). Rejected as the sole fix — the encoder can be made safe against `.`/`/` specifically, but an unbounded charset keeps inviting the *next* similar assumption failure (e.g. if a future encoding scheme needs a different marker character). Schema-level enforcement is the cheaper, more legible place to hold the invariant.

2. **Make `encodeCollectionNameSegment()` injective independent of the schema, as defense in depth.**
   - Decision: escape any literal occurrence of the marker character before encoding `/`. Concretely, process the input character by character: a literal `.` emits `..` (doubled); a `/` emits a distinct two-character marker `.x`; every other character passes through unchanged (1:1).
   - Injectivity argument: every character in the input produces a token in the output that is either exactly 1 character (any character other than `.` or `/`, passed through as itself) or exactly 2 characters starting with `.` (`..` for a literal `.`, `.x` for a `/`). Because `.` is *never* emitted as a 1-character token — it only ever appears as the first character of one of the two defined 2-character tokens — a left-to-right scan of any encoded output has exactly one valid parse: on seeing a character that isn't `.`, consume it as a literal 1-character token; on seeing `.`, consume it together with the next character and decode `..` → `.` or `.x` → `/`. This greedy parse is total and deterministic, so it defines a function `decode` with `decode(encode(x)) == x` for every input `x`. A function with a left inverse is injective, so `encode` cannot map two different inputs to the same output.
   - Rationale: this holds *regardless* of what `collection`'s schema allows, so even if Decision 1's schema tightening were ever loosened again (deliberately or by a regression), this function alone would still prevent a collision. Belt-and-suspenders, matching `fix-namespace-slash-collection-naming`'s own layered-validation precedent (schema pattern *and* a runtime `SAFE_COLLECTION_NAME_SEGMENT` guard in `collectionName()`).
   - Alternative considered: rely only on Decision 1 (schema tightening) and leave the encoder's injectivity comment as an documented-but-unverified assumption. Rejected — that is the exact failure mode that produced this bug in the first place; fixing the encoder itself costs little and removes the assumption entirely rather than just making it true for now.

## Risks / Trade-offs

- [Tightening `collection`/`category.name` validation rejects a value some existing caller currently relies on containing `.` or other special characters] -> Mitigation: no evidence any such usage exists (both are identifier-shaped fields by every current call site and by the codebase's own documented convention); the rejection is a clear `INVALID_INPUT` at the schema boundary, immediately actionable, not a silent behavior change.
- [The two-layer fix (schema + encoder) is redundant effort for what schema tightening alone would prevent] -> Accepted trade-off: the redundancy is the point — it's exactly the layered-validation pattern this codebase already uses elsewhere (e.g. `TAG_RE` at the schema layer, plus bounds checks deeper in the pipeline), and it directly prevents a second occurrence of "the encoder's injectivity assumption silently stopped holding."

## Migration Plan

1. Add `COLLECTION_NAME_RE` to `src/domain/schemas.ts` and apply it to `collection` (all current `NameSchema` call sites for that field) and `category.name`.
2. Rewrite `encodeCollectionNameSegment()` in `src/storage/qdrant.ts` to the character-by-character escaping scheme from Decision 2; update its correctness comment to state the injectivity argument directly rather than relying on an unverified schema assumption.
3. Add regression tests: `collection: "a.b"` vs `collection: "a/b"` no longer collide (`src/storage/qdrant.test.ts`); a literal `.` or `/` in `collection`/`category.name` is rejected with `INVALID_INPUT` at the schema boundary (wherever schema validation tests for these tools live); the 3 existing namespace-slash-safety tests from `fix-namespace-slash-collection-naming` still pass unchanged.
4. Run `npm run lint && npm test && npm run build` to confirm no regression.

## Open Questions

- None — the fix direction and its correctness argument are both settled; remaining work is implementation and test coverage.
