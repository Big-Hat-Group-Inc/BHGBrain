## 1. Schema tightening

- [x] 1.1 Add `COLLECTION_NAME_RE = /^[a-zA-Z0-9-]{1,100}$/` to `src/domain/schemas.ts` and apply it in place of `NameSchema` for `collection` on `RememberInputSchema`, `RecallInputSchema`/`SearchInputSchema` (whichever schema names apply), `CollectionsInputSchema`, and `ConsolidateInputSchema`. _(Renamed `NameSchema` → `CollectionNameSchema` with the regex applied, all 6 call sites updated in `src/domain/schemas.ts`; matching `pattern` added to the MCP-facing JSON schemas in `src/tools/schemas.ts` for parity with `namespace`.)_
- [x] 1.2 Apply the same pattern to `CategoryInputSchema.name`. _(Same `CollectionNameSchema` reused — `src/domain/schemas.ts`.)_

## 2. Encoder injectivity

- [x] 2.1 Rewrite `encodeCollectionNameSegment()` in `src/storage/qdrant.ts` to the character-by-character escaping scheme (literal `.` → `..`, `/` → `.x`, everything else passes through), and update its correctness comment to state the injectivity argument (deterministic left-to-right decode) directly instead of relying on an unverified schema assumption.

## 3. Validation

- [x] 3.1 Add tests in `src/storage/qdrant.test.ts` proving `collection: "a.b"` and `collection: "a/b"` (same namespace) resolve to distinct Qdrant collection names, and that the 3 existing namespace-slash-safety tests from `fix-namespace-slash-collection-naming` still pass unchanged. _(New `describe('QdrantStore collection-name encoding (dot/slash collision safety)')` block, 2 tests — including an adversarial `"a..b"` vs `"a.xb"` case for the escaping scheme itself. The 3 existing tests were updated in place for the new encoded-string literals (`.x` instead of bare `.` for an encoded slash) and still pass.)_
- [x] 3.2 Add a schema-validation test confirming a literal `.` or `/` in `collection` (and in `category.name`) is rejected with `INVALID_INPUT` at the tool-input boundary. _(New `describe('collection/category name charset (fix-collection-name-collision)')` block in `src/tools/schemas.test.ts`, 4 tests across `remember`, `collections`, and `category`.)_
- [x] 3.3 Run `npm run lint`, `npm test`, and `npm run build` to confirm no regression. _(Lint clean; 961/962 tests pass — the 1 failure is the same pre-existing `http.test.ts` timeout flake under full-suite parallel load noted in `fix-namespace-slash-collection-naming`, confirmed passing in isolation; build clean.)_
