## 1. Domain types and schemas

- [ ] 1.1 Add `MemoryOrigin` interface to `src/domain/types.ts` (near the
  `RecallFilter` interface at `src/domain/types.ts:23-26`):
  `{ session_id?: string; tool?: string; repo?: string; branch?: string }`.
- [ ] 1.2 Add `origin: MemoryOrigin | null` and `confidence: number` to `MemoryRecord`
  (`src/domain/types.ts:37-69`), placed after `embedding_model` (line 65) with a
  comment distinguishing them from `embedding_model` (content provenance vs. vector
  provenance — see `stamp-embedding-provenance`).
- [ ] 1.3 Add `origin?: MemoryOrigin | null` and `confidence?: number` to `SearchResult`
  (`src/domain/types.ts:84-108`), following the same "populated on every active
  result" convention as `tags`/`type` (not the conditional `archived?`/`vector?`
  pattern, which is feature-gated).
- [ ] 1.4 Extend `RememberInputSchema` in `src/domain/schemas.ts:26-36`:
  ```ts
  origin: z.object({
    session_id: z.string().max(200).optional(),
    tool: z.string().max(100).optional(),
    repo: z.string().max(200).optional(),
    branch: z.string().max(200).optional(),
  }).strict().optional(),
  confidence: z.number().min(0).max(1).optional(),
  ```

## 2. Config

- [ ] 2.1 Add `pipeline.default_confidence` to the Zod config schema
  (`src/config/index.ts`, inside the `pipeline` block at lines 211-216): an object
  keyed by `MemorySource` (`cli`, `api`, `agent`, `import`), each `z.number().min(0)
  .max(1)`, defaults `{ cli: 1.0, api: 1.0, agent: 0.7, import: 0.5 }`.
- [ ] 2.2 No new env vars (mirrors the `search.ranking` precedent at
  `openspec/changes/add-composite-recall-ranking/tasks.md:1.2` — `.env.example` has no
  per-field config.json reference section, and `AGENTS.md`'s "Config vs. environment"
  doesn't enumerate individual fields). Confirm no changes needed there.

## 3. Tool surface

- [ ] 3.1 Add `origin` (object, `additionalProperties: false`, matching 1.4's shape)
  and `confidence` (`{ type: 'number', minimum: 0, maximum: 1 }`) to the `remember`
  tool's `inputSchema.properties` in `src/tools/schemas.ts` (alongside `source` at
  line 15).
- [ ] 3.2 In `handleRemember` (`src/tools/index.ts:133-154`), pass `origin: input.origin
  ?? undefined` and `confidence: input.confidence` through to `ctx.pipeline.process`.

## 4. Write pipeline

- [ ] 4.1 Extend `WritePipeline.process`'s input type (`src/pipeline/index.ts:29-41`)
  and `decide`'s `input` parameter type (`src/pipeline/index.ts:82-93`) with
  `origin?: MemoryOrigin` and `confidence?: number`.
- [ ] 4.2 In `decide` (`src/pipeline/index.ts:94-103`), resolve the effective
  confidence: `const confidence = input.confidence ?? this.config.pipeline
  .default_confidence[input.source];` before the dedup/classify steps, so it's
  available on every branch (NOOP, UPDATE, DELETE-then-ADD, ADD).
- [ ] 4.3 UPDATE path (`src/pipeline/index.ts:162-195`): merge
  `confidence: Math.max(existing.confidence, confidence)` into the `updateMemory` call
  (alongside the existing `importance: Math.max(...)` at line 176); merge
  `origin: input.origin ?? existing.origin ?? null` the same way. Confirm
  `StorageManager.updateMemory`'s options type accepts both new fields (add if the
  type is a narrow `Partial<...>` that needs extending).
- [ ] 4.4 DELETE-then-ADD path (`src/pipeline/index.ts:197-248`): set
  `origin: input.origin ?? null, confidence,` on the `mem` object (lines 210-235).
- [ ] 4.5 ADD path (`src/pipeline/index.ts:250-` end of `decide`): set
  `origin: input.origin ?? null, confidence,` on the `mem` object (lines 252-270+).

## 5. SQLite storage

- [ ] 5.1 Add `origin TEXT,` and `confidence REAL NOT NULL DEFAULT 1.0,` columns to
  the `memories` table DDL (`src/storage/sqlite.ts`, after `embedding_model TEXT,` at
  line 197).
- [ ] 5.2 Add both to the additive-migration `requiredColumns` array
  (`src/storage/sqlite.ts:1816-1825`):
  `{ name: 'origin', sql: 'ALTER TABLE memories ADD COLUMN origin TEXT' }` and
  `{ name: 'confidence', sql: 'ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL
  DEFAULT 1.0' }`.
- [ ] 5.3 `insertMemory` (`src/storage/sqlite.ts:452-502`): compute `const origin =
  mem.origin ? JSON.stringify(mem.origin) : null;` and `const confidence =
  mem.confidence ?? 1.0;`, add `origin, confidence` to the column list and
  placeholders in the `INSERT INTO memories` statement, and to the bound values array.
- [ ] 5.4 `upsertMemoryFromPayload` (`src/storage/sqlite.ts:504-539+`, the
  Qdrant-recovery path): narrow `payload.origin` — if it's a plain object, JSON-encode
  it for the column; otherwise `null` (mirrors the `embeddingModel` narrowing at line
  525). Narrow `payload.confidence` — `typeof payload.confidence === 'number' ?
  payload.confidence : 1.0`.
- [ ] 5.5 `rowToMemory` (`src/storage/sqlite.ts:1659-1687`): add
  `origin: this.parseOrigin(this.getNullableString(row, 'origin')),` and
  `confidence: this.getNumber(row, 'confidence'),`. Add a small private
  `parseOrigin(raw: string | null): MemoryOrigin | null` helper that
  `JSON.parse`s and returns `null` on `null` input or a parse failure (fail-soft, not
  throw).

## 6. Qdrant payload

- [ ] 6.1 Extend `toQdrantPayload`'s parameter type (`src/storage/index.ts:801-806`)
  to `Pick<..., ... | 'confidence'>` plus `origin?: MemoryOrigin | null` in the
  intersection (alongside the existing `device_id`/`embedding_model` extras).
- [ ] 6.2 Add `origin: mem.origin ?? null, confidence: mem.confidence,` to the
  returned payload object (`src/storage/index.ts:808-826+`), stored as a native nested
  object/number (no stringification, matching `tags`).

## 7. Search / read path

- [ ] 7.1 `buildSearchResults`'s main loop (`src/search/index.ts:359-377`): add
  `origin: mem.origin, confidence: mem.confidence,` to the constructed `SearchResult`.
- [ ] 7.2 `buildResultFromQdrantPayload` (`src/search/index.ts:399-420+`, the
  cross-device SQLite-miss fallback): narrow `payload.origin` to a plain object or
  `null`, and `payload.confidence` to a number or `1.0` default, add both to the
  returned `SearchResult`.
- [ ] 7.3 Confirm (no code change expected) that `memory://{id}` and `memory://list`
  (`src/resources/index.ts:81-94`, `104-126`) surface the new fields automatically,
  since both return `MemoryRecord`/`Omit<MemoryRecord, 'embedding'>` values straight
  from `rowToMemory` with no field allowlist.

## 8. Tests

- [ ] 8.1 `src/domain/schemas.test.ts`: `RememberInputSchema` accepts valid
  `origin`/`confidence`, rejects out-of-range `confidence` and unknown `origin` keys
  (`.strict()`), and defaults both to absent when omitted.
- [ ] 8.2 `src/config/index.test.ts`: `pipeline.default_confidence` defaults and
  validates per-source bounds.
- [ ] 8.3 `src/pipeline/index.test.ts`: ADD stamps the caller's `origin`/`confidence`;
  omitted `confidence` resolves to the source's configured default; UPDATE merges
  `confidence` via `Math.max` and keeps the prior `origin` when the incoming call
  supplies none, replaces it when it does.
- [ ] 8.4 `src/storage/sqlite.test.ts`: `insertMemory`/`rowToMemory` round-trip
  `origin`/`confidence` (including `origin: null`); a pre-migration row (column
  absent) hydrates as `origin: null, confidence: 1.0`; `upsertMemoryFromPayload`
  narrows a malformed `payload.origin`/`payload.confidence` without throwing.
- [ ] 8.5 `src/storage/index.test.ts` and/or `src/storage/qdrant.test.ts`:
  `toQdrantPayload` includes `origin`/`confidence` in the upserted payload.
- [ ] 8.6 `src/search/index.test.ts`: `recall`/`search` results carry `origin`/
  `confidence` from the hydrated memory; the Qdrant-payload fallback path narrows both
  safely.
- [ ] 8.7 `src/tools/index.test.ts`: `remember` accepts `origin`/`confidence` end to
  end; a call omitting them still succeeds unchanged (backward-compatibility
  regression).

## 9. Docs and validation

- [ ] 9.1 Document `origin`/`confidence` in `README.md`'s `remember` input table
  (`README.md:2300-2311`) and in the `recall`/`search` output examples
  (`README.md:2379-2400`, `2427+`); mirror the same edits into `README.de.md`,
  `README.es.md`, `README.fr.md`, `README.zh-CN.md`.
- [ ] 9.2 Bump `package.json` `version` (currently `1.11.0`).
- [ ] 9.3 Run `npm run lint` (tsc --noEmit + eslint) and `npm test`; fix any fallout.
