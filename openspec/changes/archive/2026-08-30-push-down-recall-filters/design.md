## Context

`handleRecall` (`src/tools/index.ts:150`) calls `SearchService.search(query, ns,
collection, 'semantic', limit)` and then post-filters:

```ts
let filtered = results.filter(r => r.score >= input.min_score);
if (input.type) filtered = filtered.filter(r => r.type === input.type);
if (input.tags?.length) filtered = filtered.filter(r => input.tags!.some(t => r.tags.includes(t)));
```

Three defects follow:

1. **Starvation** — the stores return the global top-`limit`; filters then subtract.
   The caller's limit is a *ceiling on candidates*, not a count of matching results.
2. **Score-field ambiguity** — `r.score` is the mode-adjusted score (in hybrid it is an
   RRF fusion plus a possible +0.1 T0 boost). `min_score`'s 0.6 default is calibrated
   for cosine similarity only.
3. **Invisibility** — a filtered-to-zero recall is indistinguishable from "nothing
   relevant exists".

Qdrant's `query` API accepts a `filter` clause over payload fields; the payload written
by `QdrantStore` already includes `type`, `tags`, `collection`, and `namespace`.
`fullTextSearch` (`src/storage/sqlite.ts:650`) already joins `memories` and can add
predicates cheaply.

## Goals / Non-Goals

Goals:
- `limit` counts matching memories on both semantic and fulltext paths.
- `min_score` applies to `semantic_score` explicitly; the schema description says so.
- Filter starvation is observable via a metric while any post-filter remains.

Non-Goals:
- No ranking changes (that is `add-composite-recall-ranking`).
- No new filter kinds (time-range filters are a separate idea).
- No change to `search`'s lack of type/tags parameters beyond what recall needs —
  though the plumbing added here should make adding them to `search` trivial later.

## Decisions

- **Filter shape**: extend `QdrantStore.search(namespace, collection, vector, limit,
  filter?)` with `filter?: { type?: MemoryType; tags?: string[] }`, translated to a
  Qdrant `must` clause (`type` match, `tags` `match any`). SQLite mirrors the same
  object as SQL predicates (`m.type = ?`, tag membership against the serialized tags
  column using the existing LIKE machinery until FTS5 lands).
- **Tags semantics**: preserve current recall behavior — OR over provided tags
  (`match any`), since `handleRecall` uses `.some(...)` today.
- **Score threshold**: applied against `semantic_score ?? score` so semantic mode is
  unchanged; the defensive check lives in `handleRecall`, not the stores.
- **Expiry**: expired-memory exclusion already happens in `buildSearchResults`; a
  Qdrant hit whose SQLite row is expired still costs a candidate slot. Accepted —
  over-fetch (`limit * 2` from Qdrant, capped) compensates, matching the hybrid path's
  existing over-fetch convention.

## Risks / Trade-offs

- Qdrant payload filters require the payload fields to exist on old points. Points
  written before `type`/`tags` were added to the payload would be silently excluded
  when a filter is active. Mitigation: treat missing payload fields as non-matching
  only when a filter is explicitly requested (documented), and note `repair` re-upserts
  full payloads.
- Tag filtering in SQLite against a serialized column is approximate (substring risk);
  use delimiter-aware matching and re-verify post-hydration (the defensive re-check).
