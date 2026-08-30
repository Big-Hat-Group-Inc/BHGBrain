## Why

`memory://inject` is the flagship session-context feature, but its memory selection is
recency masquerading as relevance: `buildInjectPayload` (`src/resources/index.ts:137`)
appends categories and then "Top-K relevant memories" — where the code under that
comment is `listMemories(namespace, topK)`, i.e. **newest K**, no relevance involved.
A session about deployment gets whatever was stored most recently, however unrelated.

Separately, the budget is `auto_inject.max_chars` (default 30000 chars) while every
consumer of an inject block budgets in *tokens*; a char budget over- or under-fills
the context window depending on content (code vs prose vs CJK), and the categories
section can consume the entire budget before a single memory is injected.

## What Changes

- Add a parameterized resource template `memory://inject/{hint}`: the hint (a task
  phrase, repo name, or topic) drives hybrid search to select the top-K memories,
  with the existing composite/RRF ranking; expiry filtering and access recording
  behave exactly like normal search.
- `memory://inject` (no hint) keeps its current recency behavior as the fallback —
  and its section comment stops claiming relevance it doesn't have.
- Split the budget: a configurable fraction reserved for memories
  (`auto_inject.memory_budget_fraction`, default 0.4) so categories can no longer
  starve the memory section entirely.
- Add token-estimate budgeting: `auto_inject.budget_unit: 'chars' | 'tokens'`
  (default `chars` for compatibility); `tokens` uses a chars/4 estimate applied
  consistently across sections — no tokenizer dependency.
- Near-duplicate suppression within the injected memory set: greedy skip of memories
  whose vector similarity to an already-selected memory exceeds the configured dedup
  threshold (vectors are in hand from the hybrid search result).
- Update README ×5 (resources section + auto-inject docs), `CLAUDE.md` resource list
  (new template), version bump.

## Capabilities

### New Capabilities
- `relevance-conditioned-inject`: Session inject can be conditioned on a hint so the
  memory section is selected by hybrid relevance rather than recency, under split,
  unit-configurable budgets, with near-duplicate suppression.

### Modified Capabilities

## Impact

- Affected code: `src/resources/index.ts` (template + payload builder),
  `src/config/index.ts` (`auto_inject` schema additions), `src/search/index.ts`
  (reuse; possible small export), tests.
- Behavior: `memory://inject` unchanged by default; the new template and config knobs
  are additive. MCP resource surface grows by one template → CLAUDE.md + README ×5
  sync required (repo rule).
- Degraded mode: hint-driven selection inherits hybrid's fulltext-only fallback when
  embeddings are down — inject keeps working, `truncated`/health signal unchanged.
