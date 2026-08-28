## 1. Storage: `recall_feedback` table

- [ ] 1.1 Add a `recall_feedback` table to `SCHEMA_SQL` in `src/storage/sqlite.ts`
  (alongside `memory_archive`, `src/storage/sqlite.ts:272-283`):
  ```sql
  CREATE TABLE IF NOT EXISTS recall_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    query TEXT,
    score REAL,
    useful INTEGER NOT NULL CHECK(useful IN (0,1)),
    client_id TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recall_feedback_memory_id ON recall_feedback(memory_id);
  CREATE INDEX IF NOT EXISTS idx_recall_feedback_created_at ON recall_feedback(created_at DESC);
  ```
  Purely additive (`CREATE TABLE IF NOT EXISTS`) — no migration step, consistent with
  every other table in this block.
- [ ] 1.2 Add `RecallFeedbackEntry` to `src/domain/types.ts` after `ArchiveRecord`
  (`src/domain/types.ts:223-233`):
  ```ts
  export interface RecallFeedbackEntry {
    memory_id: string;
    namespace: string;
    query: string | null;
    score: number | null;
    useful: boolean;
    client_id: string;
    created_at: string;
  }
  ```
- [ ] 1.3 Add `recordFeedback(entry: RecallFeedbackEntry): void` to the sqlite store
  interface and implementation in `src/storage/sqlite.ts` (interface block near
  `insertAudit`/`archiveMemory`, `src/storage/sqlite.ts:126-159`; implementation near
  `insertAudit`, `src/storage/sqlite.ts:1487-1500`), following the same
  `assertMutableAllowed()` + parameterized `db.run` pattern `insertAudit` uses. Call
  `flushIfDirty()` from the tool handler after the insert, same as `handleReview`
  does for `updateMemory` (`src/tools/index.ts:340`) — do not flush inside the store
  method itself, matching the existing convention that mutation methods don't
  self-flush.
- [ ] 1.4 Do **not** add a corresponding `logAudit` call — `recall_feedback` is a
  separate, non-mutating event stream (design.md "Not written to audit_log").

## 2. Domain schema

- [ ] 2.1 Add `FeedbackInputSchema` to `src/domain/schemas.ts` after
  `ReviewInputSchema` (`src/domain/schemas.ts:98-112`) and before `RepairInputSchema`
  (`src/domain/schemas.ts:114`):
  ```ts
  export const FeedbackInputSchema = z.object({
    id: z.string().uuid(),
    useful: z.boolean(),
    query: z.string().max(500).optional(),
    score: z.number().min(0).max(1).optional(),
  }).strict();
  ```
- [ ] 2.2 Add `export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;` next
  to the other input-type exports (`src/domain/schemas.ts:137-147`).
- [ ] 2.3 Add coverage in `src/domain/schemas.test.ts` (alongside the existing
  `RecallInputSchema`/`ReviewInputSchema` describe blocks, `src/domain/schemas.test.ts:63`
  onward): valid minimal input (`id` + `useful` only), rejects non-UUID `id`, rejects
  `score` outside `[0,1]`, rejects unknown keys (`.strict()`), rejects `query` over 500
  chars.

## 3. Tool registration

- [ ] 3.1 Add a `feedback` entry to `MCP_TOOL_DEFINITIONS` in `src/tools/schemas.ts`,
  after `review` (`src/tools/schemas.ts:171-186`) and before `repair`
  (`src/tools/schemas.ts:188`):
  ```ts
  {
    name: 'feedback',
    description: 'Record whether a previously recalled/searched memory was useful. Purely additive — has no effect on ranking, lifecycle, or future recall results in this version.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', format: 'uuid', description: 'The memory ID from a prior recall/search result' },
        useful: { type: 'boolean', description: 'Whether the result was useful' },
        query: { type: 'string', maxLength: 500, description: 'The query that produced this result, for later analysis (not validated against any prior call)' },
        score: { type: 'number', minimum: 0, maximum: 1, description: 'The score the caller observed for this result, for later analysis' },
      },
      required: ['id', 'useful'],
      additionalProperties: false,
    },
  },
  ```
- [ ] 3.2 Import `FeedbackInputSchema` in `src/tools/index.ts`'s import block
  (`src/tools/index.ts:11-17`) and add `handleFeedback` after `handleReview` ends
  (`src/tools/index.ts:560`) and before `handleRepair` (`src/tools/index.ts:562`):
  ```ts
  async function handleFeedback(
    ctx: ToolContext, args: unknown, clientId: string, logCtx: ToolLogContext,
  ): Promise<{ id: string; useful: boolean; recorded_at: string }> {
    const input = parseInput(FeedbackInputSchema, args);
    const mem = ctx.storage.sqlite.getMemoryById(input.id);
    if (!mem) throw notFound(`Memory ${input.id} not found`);
    logCtx.namespace = mem.namespace;

    const created_at = new Date().toISOString();
    ctx.storage.sqlite.recordFeedback({
      memory_id: input.id,
      namespace: mem.namespace,
      query: input.query ?? null,
      score: input.score ?? null,
      useful: input.useful,
      client_id: clientId,
      created_at,
    });
    ctx.storage.sqlite.flushIfDirty();

    return { id: input.id, useful: input.useful, recorded_at: created_at };
  }
  ```
- [ ] 3.3 Add the dispatcher case in `handleTool`'s switch (`src/tools/index.ts:116-127`,
  next to `case 'review': return handleReview(...)` at line 126):
  `case 'feedback': return handleFeedback(ctx, args, clientId, logCtx);`

## 4. Tests

- [ ] 4.1 In `src/tools/index.test.ts` (co-located with the other `handle*` tests, see
  existing `review`/`revisions` describe blocks), cover: recording feedback for an
  existing memory returns `{ id, useful, recorded_at }`; `NOT_FOUND` for a nonexistent
  or archived `id` (archived rows excluded — `getMemoryById(id)` without
  `includeArchived: true`); optional `query`/`score` persisted when provided and
  `null` when omitted; `useful: false` recorded distinctly from `useful: true`.
- [ ] 4.2 In `src/storage/sqlite.test.ts`, cover `recordFeedback` directly: row
  persists with correct `memory_id`/`namespace`/`useful`/`created_at`; multiple
  feedback rows for the same `memory_id` all persist (event stream, not a single
  upserted row per memory); `assertMutableAllowed()` guard applies the same as other
  mutation methods (e.g. during a lifecycle operation or read-only mode).
- [ ] 4.3 Confirm (via a targeted assertion, not new production code) that recording
  feedback does not alter `buildSearchResults` ordering or any `search.ranking`
  computation — a regression guard that this change stays inert per design.md's
  Non-Goals.

## 5. Docs

- [ ] 5.1 Add a `### \`feedback\` - Record Recall Usefulness` section to `README.md`'s
  MCP Tools Reference (after `review`, `README.md:2738` region, before `repair`),
  modeled on the `review`/`recall` sections' Input table + Output JSON format
  (`README.md:2363-2426`, `README.md:2738-2832`). State explicitly that this version
  has no effect on ranking or lifecycle.
- [ ] 5.2 Mirror the same section into `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md` in their corresponding MCP Tools Reference position (translated
  prose, identical structure/JSON) — repo rule: a user-facing `README.md` change lands
  in all five or none.
- [ ] 5.3 Update `CLAUDE.md`'s canonical tool list (`CLAUDE.md:16-17`) to append
  `feedback` to the `Registered:` list.
- [ ] 5.4 Bump `package.json` `version` (`package.json:3`, currently `1.11.0`) per a
  user-visible MCP surface change.
- [ ] 5.5 `.env.example` and `AGENTS.md`: no changes — this adds no environment
  variable and no config-vs-env resolution behavior.

## 6. Validation

- [ ] 6.1 `npm run lint` (tsc --noEmit + eslint src) passes.
- [ ] 6.2 `npm test` passes, including the new tests from section 4.
- [ ] 6.3 Confirm README ×5 stayed in sync (spot-check the new section renders
  identically in structure across all five files) and `CLAUDE.md`'s tool list matches
  `MCP_TOOL_DEFINITIONS` exactly.
