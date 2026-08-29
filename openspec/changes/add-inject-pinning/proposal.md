## Why

`add-relevance-conditioned-inject` closed the recency-vs-relevance gap in
`memory://inject`: hintless reads still rank by recency, hinted reads
(`memory://inject/{hint}`) rank by hybrid relevance, both under a split
token/char budget with near-duplicate suppression. Neither path can guarantee a
specific fact makes it in. A critical operating rule ("always use pnpm, never
npm") stored today competes with every other memory on recency or relevance —
if nothing has referenced it recently and the current hint doesn't match it
closely, it silently drops out of the injected context exactly when an agent
needs it least deniably.

`T0` looks like it should solve this but doesn't: T0 only affects retention
(never expires) and contributes a small multiplicative prior in
`compositeScore` (`src/search/index.ts:312-330`, gated by `search.ranking`,
`add-composite-recall-ranking`) — it raises a memory's odds of ranking well,
it does not guarantee inclusion. There is no mechanism today that forces a
memory into the injected set regardless of where recency or relevance would
otherwise place it.

## What Changes

- Add a `pinned` boolean field to `MemoryRecord`, defaulting to `false`,
  settable via the `remember` tool (at write time, and via explicit override
  on the UPDATE dedup path) and via the `tag` tool (a lightweight toggle that
  does not touch content).
- Enforce a per-namespace cap on the number of pinned memories
  (`defaults.pin_limit_per_namespace`, default 20) so pinning stays a small,
  deliberate set of critical facts rather than a second unbounded inject path.
- `buildInjectPayload` (`src/resources/index.ts:205-308`) always includes a
  namespace's pinned memories in the memory section, ahead of the
  recency-selected (`memory://inject`) or relevance-selected
  (`memory://inject/{hint}`) candidates, for both templates uniformly. Pinned
  memories consume the memory section's existing reserved budget share
  (`auto_inject.memory_budget_fraction`) rather than a new separate carve-out.
- Pinned memories are exempt from near-duplicate suppression in both
  directions (never suppressed, never used to suppress a relevance/recency
  candidate); a memory that is both pinned and independently selected is
  included exactly once via ID exclusion, not vector comparison.
- `pinned` is persisted to the Qdrant payload and restored by
  `repair --mode from-qdrant`, so pins survive cross-device sync and SQLite
  rebuilds.
- Pinning has no effect on `search`/`recall` ordering or `SearchResult` — it
  is an inject-selection guarantee only, deliberately distinct from T0's
  retention/ranking effect (`add-composite-recall-ranking` is untouched).
- Document the flag and its two entry points in `README.md` ×5 and bump
  `package.json` version.

## Capabilities

### New Capabilities
- `inject-pinning`: Memories can be pinned so they are always included in
  `memory://inject` and `memory://inject/{hint}` payloads regardless of
  recency or relevance rank, bounded by a per-namespace cap and the existing
  inject budget.

### Modified Capabilities

## Impact

- Affected code: `src/domain/types.ts` (`MemoryRecord.pinned`),
  `src/domain/schemas.ts` (`RememberInputSchema`, `TagInputSchema`),
  `src/tools/schemas.ts` (`remember`, `tag` MCP schemas),
  `src/tools/index.ts` (`handleRemember`, `handleTag`, cap enforcement),
  `src/pipeline/index.ts` (ADD/UPDATE merge semantics for `pinned`),
  `src/storage/sqlite.ts` (column, migration, index, `insertMemory`,
  `upsertMemoryFromPayload`, `updateMemory`, `rowToMemory`, new
  `listPinnedMemories`/`countPinnedMemories`), `src/storage/index.ts`
  (`toQdrantPayload`), `src/resources/index.ts` (`buildInjectPayload`),
  `src/config/index.ts` (`defaults.pin_limit_per_namespace`,
  `auto_inject.pinned_enabled`), co-located tests.
- Behavior: `memory://inject` and `memory://inject/{hint}` payloads grow a
  pinned-first section when pins exist; no other tool or resource changes
  behavior when no memory is pinned (all new config defaults are additive/
  inert). `search`, `recall`, and composite ranking are unaffected.
- Docs: README ×5 (Memory Data Model table, `remember`/`tag` tool reference,
  both inject resource sections), version bump. `CLAUDE.md`'s canonical
  tool/resource lists are unchanged — this adds parameters to existing tools,
  not new tools or resources.
- Depends on: `add-relevance-conditioned-inject` (already shipped — this
  change extends `buildInjectPayload` and reuses its budget/suppression
  machinery rather than re-deriving it).
