## 1. Identity and stamping

- [x] 1.1 Define a canonical embedding identity string
  (`<provider>/<model>@<dimensions>`) derived from active config; expose it from the
  embedding provider layer (`src/embedding/index.ts`, `azure-foundry.ts`).
- [x] 1.2 Add `embedding_model: string | null` to `MemoryRecord`
  (`src/domain/types.ts`) and an additive, idempotent SQLite column migration
  (`src/storage/sqlite.ts`), NULL for legacy rows.
- [x] 1.3 Stamp the identity on every vector-producing write path
  (`src/pipeline/index.ts` ADD/UPDATE/DELETE-replace, restore re-embed, repair) in
  both the SQLite row and the Qdrant payload.

## 2. Startup detection

- [x] 2.1 Persist the store's expected identity in SQLite config metadata on first
  stamped write; on startup compare with active config.
- [x] 2.2 On mismatch: structured warning with both identities, `embedding` health
  component degraded with an explanatory message, and a config flag
  (`embedding.refuse_writes_on_model_mismatch`, default true) that makes
  vector-producing writes fail with a clear error instead of mixing spaces.
- [x] 2.3 Dimension changes additionally validate against the Qdrant collection
  dimension and produce an actionable error naming the re-embed path.

## 3. Re-embed migration

- [x] 3.1 Add an operator-initiated re-embed path (extend `repair` with
  `mode: "re-embed"` or a CLI flag): select rows whose stamp differs from the active
  identity (optionally including NULL-stamped legacy rows via a flag), re-embed in
  bounded batches, upsert vector + stamp, resumable via `vector_synced`/stamp state.
- [x] 3.2 Rate/failure handling: batch size configurable, per-batch error isolation,
  progress logging and a final summary (updated / failed / remaining).
- [x] 3.3 A completed re-embed updates the store's expected identity and clears the
  mismatch condition without restart.

## 4. Tests

- [x] 4.1 New writes carry the stamp in SQLite and Qdrant payload.
- [x] 4.2 Startup mismatch: health degraded + warning; writes refused when the flag is
  on, permitted (with stamp) when off.
- [x] 4.3 Re-embed: mixed-stamp store converges to the active identity; interruption
  mid-run resumes without re-processing completed rows; legacy NULL rows included
  only when requested.

## 5. Docs

- [x] 5.1 Document the migration procedure (change model → observe degraded health →
  run re-embed → healthy) in README ×5 and `AGENTS.md`; document the new config
  flag(s) and any env var in `.env.example`; bump `package.json` version.
- [x] 5.2 `npm run lint` and `npm test` pass.
