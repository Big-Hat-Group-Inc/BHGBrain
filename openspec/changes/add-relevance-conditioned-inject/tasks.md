## 1. Config

- [x] 1.1 Extend the `auto_inject` Zod schema (`src/config/index.ts`):
  `memory_budget_fraction` (0-1, default 0.4), `budget_unit` (`chars` | `tokens`,
  default `chars`), `dedup_suppression` (boolean, default true).

## 2. Hint-conditioned selection

- [x] 2.1 Add `memory://inject/{hint}` to the resource handler and
  `ListResourceTemplates` (`src/resources/index.ts`); URI-decode and length-cap the
  hint, reusing the search query limit (500 chars).
- [x] 2.2 Selection: hybrid search with the hint over the resolved namespace, top
  `auto_inject_limit` results; expiry filtering and access recording identical to
  normal search; recency fallback when the hint is empty after trimming.
- [x] 2.3 Hintless `memory://inject` behavior unchanged; correct the misleading
  "Top-K relevant" comment.

## 3. Budgeting

- [x] 3.1 Implement the split budget: categories draw from the full budget minus the
  reserved memory fraction; memories always get at least their reserved share when
  they exist.
- [x] 3.2 Implement `budget_unit: 'tokens'` as a chars/4 estimate applied uniformly
  (categories, memories, truncation flags); `chars` path byte-for-byte identical to
  today.

## 4. Near-duplicate suppression

- [x] 4.1 Greedy suppression: skip a candidate whose similarity to an
  already-selected memory exceeds `deduplication.similarity_threshold`, using vectors
  returned by the semantic leg; candidates without vectors (fulltext-only) are never
  suppressed.

## 5. Tests

- [x] 5.1 Hint selects relevant memories over newer irrelevant ones (seeded store,
  mocked embedding).
- [x] 5.2 Reserved fraction: oversized categories leave the memory section its share;
  fraction 0 restores current starvation behavior.
- [x] 5.3 Token-unit budgeting truncates at the estimated token budget; chars mode
  regression-identical.
- [x] 5.4 Near-duplicates suppressed; suppression disabled honors config.
- [x] 5.5 Degraded (embedding down): hinted inject serves fulltext-only selection.

## 6. Docs (MCP surface change — full sync required)

- [x] 6.1 Update `CLAUDE.md` resource template list; README ×5 (resources +
  auto-inject sections); bump `package.json` version.
- [x] 6.2 `npm run lint` and `npm test` pass.
