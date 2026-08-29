## Why

`source: 'cli' | 'api' | 'agent' | 'import'` (`src/domain/types.ts:5`) is the entire
story a memory tells about where its *content* came from. It cannot answer "which
session said this," "was this an explicit user statement or an agent's guess," or
"which repo/branch was checked out when this was written." For a long-lived store fed
by multiple MCP clients (Claude CLI, Codex, Gemini) across many repos, that is exactly
the context a caller needs to weigh conflicting or stale-looking memories, and it is
lost forever the moment a memory is written — there is nowhere to put it.

This is **not** the same gap the already-built and archived `stamp-embedding-provenance`
change (`openspec/changes/archive/2026-08-27-stamp-embedding-provenance/`) closed. That
change stamps `MemoryRecord.embedding_model` (`src/domain/types.ts:65`,
provider-qualified, e.g. `openai/text-embedding-3-small@1536`) so a mismatched embedding
space can be detected after a model change — it answers "which model produced this
*vector*." This proposal answers a different question entirely: "where did this
*belief* come from, and how much should it be trusted?" The two are complementary and
deliberately live in separate fields — `embedding_model` for vector identity, `origin`/
`confidence` (introduced here) for content identity — so neither name collides with or
overloads the other. Nothing in this proposal touches `embedding_model`, the embedding
mismatch-detection logic in `src/storage/index.ts:87-112`, or the `re-embed` repair path.

Two of the three signals `MemoryRecord` already carries near-miss this problem without
solving it: `importance` (`src/domain/types.ts:49`, caller-supplied but never a measure
of *trust*) and `source` (an origin-*category*, not an origin-*identity*). Neither lets
a caller distinguish "the user told me this directly" from "I inferred this from
context," or trace a memory back to the session/repo it was written from.

## What Changes

- Add `origin: MemoryOrigin | null` to `MemoryRecord` — an optional, caller-supplied
  object (`session_id`, `tool`, `repo`, `branch`), each field a free-form string since
  MCP has no standardized identity for any of them. All fields optional; the whole
  object is `null` when the caller supplies nothing (the common case today, and always
  the case for pre-existing rows).
- Add `confidence: number` ([0,1]) to `MemoryRecord` — how much to trust this memory's
  content. Caller-supplied on `remember`; when omitted, defaults from
  `pipeline.default_confidence[source]` (new config, defaults: `cli: 1.0, api: 1.0,
  agent: 0.7, import: 0.5`) so an explicit user statement defaults to full trust and an
  agent's inference defaults lower, per the brainstorm's "explicit user statement >
  agent inference."
- `remember` accepts optional `origin` and `confidence` inputs; both are additive and
  `additionalProperties: false`-safe (existing callers unaffected).
- On the UPDATE dedup path, `confidence` merges via `Math.max(existing, incoming)` (same
  policy as `importance` at `src/pipeline/index.ts:176`) and `origin` is replaced only
  when the incoming call supplies one, otherwise the prior origin is kept.
- Both fields are persisted in SQLite (new `origin TEXT`, `confidence REAL` columns,
  additive migration) and in the Qdrant payload, and are surfaced wherever
  `MemoryRecord`/`SearchResult` already flow to callers: `recall`, `search`,
  `memory://{id}`, `memory://list` — no new tool or resource is introduced.
- Document the new `remember` parameters and `recall`/`search` output fields in
  `README.md` ×5; bump `package.json` version.

## Capabilities

### New Capabilities
- `content-provenance`: Every memory can record where its content came from
  (session/tool/repo/branch) and how much to trust it (confidence), distinct from
  `embedding-provenance`'s vector-identity tracking, surfaced on every read path that
  already returns memory records.

### Modified Capabilities

## Impact

- Affected code: `src/domain/types.ts` (+`MemoryOrigin`, +`origin`/`confidence` on
  `MemoryRecord`/`SearchResult`), `src/domain/schemas.ts` (`RememberInputSchema`),
  `src/tools/schemas.ts` (remember tool input), `src/tools/index.ts`
  (`handleRemember`), `src/pipeline/index.ts` (`process`/`decide`, ADD/UPDATE/DELETE
  paths), `src/storage/sqlite.ts` (schema, migration, `insertMemory`,
  `upsertMemoryFromPayload`, `rowToMemory`), `src/storage/index.ts` (`toQdrantPayload`),
  `src/search/index.ts` (`buildSearchResults`, `buildResultFromQdrantPayload`),
  `src/config/index.ts` (`pipeline.default_confidence`), tests.
- Storage: additive SQLite columns (`origin` nullable TEXT, `confidence` REAL NOT NULL
  DEFAULT 1.0) and an additive Qdrant payload field; legacy rows read back as
  `origin: null`, `confidence: 1.0`.
- Backward compatibility: every new input field is optional; no existing `remember`
  call, config, or response shape changes for callers that don't supply the new fields.
- **Ranking integration (flagged, not built here):** `add-composite-recall-ranking`
  (already built and merged) computes a prior in `SearchService.compositeScore`
  (`src/search/index.ts:312-330`) from `importance`, `access_count`, and tier-decay.
  `confidence` is a natural fourth term — a low-confidence agent inference should rank
  below an equally relevant, equally important explicit statement. Wiring a
  `w_confidence` weight into that formula is a small, isolated follow-on once this
  proposal lands the field; it is deliberately **not** included here to keep this
  change to schema + plumbing, and because a ranking-formula change deserves its own
  review of defaults and regression tests (as `add-composite-recall-ranking` gave its
  own weights).
- Docs: README ×5 (`remember` input table, `recall`/`search` output examples),
  `AGENTS.md` unchanged (no new env vars, no config-vs-environment change), version
  bump.
