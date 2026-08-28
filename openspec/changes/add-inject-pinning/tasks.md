## 1. Schema, storage, and durability

- [ ] 1.1 Add `pinned: boolean` to `MemoryRecord` (`src/domain/types.ts:37-69`).
- [ ] 1.2 Add the column and index to the SQLite schema
  (`src/storage/sqlite.ts:174-214`): `pinned INTEGER NOT NULL DEFAULT 0`, plus
  `CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(namespace, pinned)`.
- [ ] 1.3 Add an additive migration entry to `ensureMemoryColumns`
  (`src/storage/sqlite.ts:1816-1825`):
  `{ name: 'pinned', sql: "ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0" }`.
- [ ] 1.4 Read `pinned` back in `rowToMemory` via `getBoolean`
  (`src/storage/sqlite.ts:1672-1680`).
- [ ] 1.5 Include `pinned` in `insertMemory`'s column list and bound params
  (`src/storage/sqlite.ts:452-502`), defaulting to `false` when absent.
- [ ] 1.6 Add `pinned` to `updateMemory`'s boolean-coercion branch alongside
  `decay_eligible`/`archived`/`vector_synced` (`src/storage/sqlite.ts:590-592`)
  so a partial update can set it without special-casing.
- [ ] 1.7 Parse `payload.pinned` (boolean, default `false`) in
  `upsertMemoryFromPayload` and include it in its `INSERT`
  (`src/storage/sqlite.ts:504-576`) so `repair --mode from-qdrant` and the
  cross-device rebuild path restore pin state instead of resetting it.
- [ ] 1.8 Add `pinned` to the `Pick<...>` type and the returned object in
  `toQdrantPayload` (`src/storage/index.ts:801-830`) so every upsert path
  (`src/storage/index.ts:145,220,610,700`) writes it to Qdrant.
- [ ] 1.9 Add `listPinnedMemories(namespace: string): MemoryRecordWithoutEmbedding[]`
  (ordered `updated_at DESC`, excluding archived/expired the same way
  `listMemories` does) and `countPinnedMemories(namespace: string): number` to
  the `SqliteStore` interface and implementation
  (`src/storage/sqlite.ts:82`, `:662` for the sibling `listMemories` to model
  from).

## 2. Config

- [ ] 2.1 Add `pin_limit_per_namespace` to the `defaults` block
  (`src/config/index.ts:113-120`): `z.number().int().min(1).max(200).default(20)`.
- [ ] 2.2 Add `pinned_enabled` to the `auto_inject` block
  (`src/config/index.ts:190-205`, alongside `dedup_suppression`):
  `z.boolean().default(true)`.

## 3. Write-path settability

- [ ] 3.1 Add optional `pinned: z.boolean().optional()` to `RememberInputSchema`
  (`src/domain/schemas.ts:26-36`) and to the `remember` entry in
  `MCP_TOOL_DEFINITIONS` (`src/tools/schemas.ts:3-21`).
- [ ] 3.2 Add optional `pinned: z.boolean().optional()` to `TagInputSchema`
  (`src/domain/schemas.ts:64-68`) and to the `tag` entry in
  `MCP_TOOL_DEFINITIONS` (`src/tools/schemas.ts:69-82`).
- [ ] 3.3 Thread `pinned` through `WritePipeline.process`'s input type and
  into the `MemoryCandidate`/decide path (`src/pipeline/index.ts:10-15`,
  `:29-41`, `:61-79`), and pass `input.pinned` from `handleRemember`
  (`src/tools/index.ts:133-153`).
- [ ] 3.4 Implement explicit-set-wins merge semantics for `pinned` on both
  UPDATE paths — same pattern as `explicitTier`
  (`src/pipeline/index.ts:102`, `:367`), not the `Math.max` OR-merge used for
  `importance` (`src/pipeline/index.ts:176`, `:397`): `pinned: input.pinned
  !== undefined ? input.pinned : existing.pinned` at both merge sites
  (`src/pipeline/index.ts:162-191`, `:385-413`); on ADD, default to `false`
  when `input.pinned` is absent (`src/pipeline/index.ts:221-264`,
  `:432-...`).
- [ ] 3.5 Enforce `defaults.pin_limit_per_namespace` in `handleRemember`
  (`src/tools/index.ts:133-153`) and `handleTag`
  (`src/tools/index.ts:239-260`): before a mutation that would newly set
  `pinned: true` on a memory not already pinned, check
  `countPinnedMemories(namespace) < pin_limit_per_namespace`; throw
  `invalidInput` (matching the existing 20-tag-limit pattern at
  `src/tools/index.ts:257-259`) when the cap would be exceeded.

## 4. Inject integration

- [ ] 4.1 In `buildInjectPayload` (`src/resources/index.ts:205-308`), add a
  pinned-memory step between category assembly (`:237-267`) and the existing
  recency/relevance selection (`:269-296`): when
  `auto_inject.pinned_enabled`, fetch `listPinnedMemories(namespace)` and
  append each via the existing `appendBlock` mechanics
  (content-or-summary sizing, same as `:284-296`), counting toward
  `memoriesCount`.
- [ ] 4.2 Exclude pinned memory IDs from the recency (`listMemories`) and
  relevance (`searchForInject`) candidate lists before appending them
  (`src/resources/index.ts:269-296`), via a `Set` of already-included IDs —
  so a memory that is both pinned and independently selected appears exactly
  once and doesn't consume an extra slot of `auto_inject_limit`.
- [ ] 4.3 Confirm (and comment, where the code doesn't already make it
  obvious) that `suppressNearDuplicates` (`src/resources/index.ts:192-203`)
  is invoked only on the post-exclusion recency/relevance candidate list —
  pinned memories are never passed through it and never pre-seed its
  `selected` accumulator, per the design's near-duplicate-exemption decision.
- [ ] 4.4 Confirm the pinned step runs identically for `memory://inject` and
  `memory://inject/{hint}` (i.e., before the `trimmedHint` branch at
  `src/resources/index.ts:274-281`, not duplicated inside it).

## 5. Tests

- [ ] 5.1 `remember` sets `pinned` on ADD (explicit `true`/`false`/omitted →
  default `false`).
- [ ] 5.2 `remember` UPDATE merge: omitting `pinned` preserves the existing
  memory's pin state; passing `pinned` explicitly overrides it (both
  directions: pin → unpin, unpin → pin).
- [ ] 5.3 `tag` sets/unsets `pinned` without touching `content`/`tags`/
  `updated_at`-adjacent fields beyond what tagging already touches.
- [ ] 5.4 Pin cap: the `(pin_limit_per_namespace + 1)`th pin via `remember`
  and via `tag` both return `INVALID_INPUT`; unpinning first then re-pinning
  succeeds; the cap is per-namespace (pinning to capacity in namespace A
  doesn't block pinning in namespace B).
- [ ] 5.5 Hintless inject (`memory://inject`) includes all of a namespace's
  pinned memories ahead of the recency-selected set, even when none of the
  pins are among the most recent memories.
- [ ] 5.6 Hinted inject (`memory://inject/{hint}`) includes all of a
  namespace's pinned memories ahead of the relevance-selected set, even when
  none of the pins match the hint.
- [ ] 5.7 A memory that is both pinned and would independently rank in the
  top-K (recency or relevance) appears exactly once in the payload.
- [ ] 5.8 Near-duplicate suppression: two near-duplicate pinned memories are
  both injected (not suppressed against each other); a pinned memory and a
  near-duplicate relevance-selected memory are both injected (pin is not
  suppressed by, and does not suppress, the relevance candidate).
- [ ] 5.9 `auto_inject.pinned_enabled: false` restores byte-for-byte the
  pre-this-change payload for a namespace with pinned memories (i.e., pins
  are stored but inert for inject purposes).
- [ ] 5.10 Budget: pinned content that alone exceeds the memory section's
  reserved share truncates per-item using the existing truncation rules and
  sets `truncated: true`, exactly as oversized category/relevance content
  does today.
- [ ] 5.11 Durability: `pinned: true` round-trips through `toQdrantPayload` /
  `upsertMemoryFromPayload` — a `repair --mode from-qdrant` rebuild of a
  SQLite row restores `pinned: true` rather than defaulting it to `false`.
- [ ] 5.12 Regression: `search`/`recall` result ordering and `SearchResult`
  shape are unaffected by a memory's `pinned` state (no new field, no score
  change).

## 6. Docs

- [ ] 6.1 Add a `pinned` row to the Memory Data Model table in `README.md`
  (`README.md:899-924`) and the four translations.
- [ ] 6.2 Document `pinned` in the `remember` and `tag` tool reference tables
  (`README.md:2300-2310`, `:2452-2456`) and the four translations.
- [ ] 6.3 Document the pinned-memory step, its budget source, the
  near-duplicate exemption, and `auto_inject.pinned_enabled` in both inject
  resource sections (`README.md:2068-2126`) and the four translations.
- [ ] 6.4 Bump `package.json` version.
- [ ] 6.5 `npm run lint` and `npm test` pass.
