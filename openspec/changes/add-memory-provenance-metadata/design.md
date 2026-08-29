## Context

`MemoryRecord` (`src/domain/types.ts:37-69`) already grew one provenance field this way:
`embedding_model`, added by `stamp-embedding-provenance` (archived
`openspec/changes/archive/2026-08-27-stamp-embedding-provenance/`), which stamps which
embedding *model* produced a vector. That change's write-path pattern —
`src/storage/index.ts:126-154` (`writeMemory` stamps the field unconditionally at write
time), `src/storage/sqlite.ts`'s additive-column migration (`requiredColumns` array,
`src/storage/sqlite.ts:1816-1825`), and the single `rowToMemory` hydration function
(`src/storage/sqlite.ts:1659-1687`) — is the template this change follows for a
different pair of fields: `origin` and `confidence`, which describe the *content's*
provenance, not the vector's.

Every field this change needs to read is already assembled at the exact place it's
needed: `WritePipeline.decide` (`src/pipeline/index.ts:82-93`) already receives
`source`, and `SearchService.buildSearchResults` (`src/search/index.ts:332-392`)
already has the full hydrated `MemoryRecord` in hand when it builds each
`SearchResult`. No new I/O, no new tool, no new resource.

## Goals / Non-Goals

Goals:
- Let a caller optionally attach `origin` (session/tool/repo/branch) and `confidence`
  ([0,1]) to a memory on `remember`, and read both back via every existing path that
  already returns memory records (`recall`, `search`, `memory://{id}`,
  `memory://list`).
- Sensible confidence defaults by `source` when the caller doesn't specify one, so the
  field is useful even for callers who never adopt it explicitly.
- Fully additive: no existing input, output, or config shape changes for callers who
  ignore the new fields.

Non-Goals:
- No automatic derivation of `session_id`/`repo`/`branch` from the MCP transport. HTTP's
  `clientId` (`src/transport/middleware.ts:82-84`) is `req.ip` — a security identity for
  rate-limiting and audit, not a session or tool identity — and stdio's default
  `clientId` is the literal string `'unknown'` (`src/tools/index.ts:64`). Neither is a
  usable proxy for "which conversation/tool/repo produced this memory." These fields
  are caller-supplied only; auto-derivation is future work if a client-side convention
  emerges.
- No wiring of `confidence` into `SearchService.compositeScore`
  (`src/search/index.ts:312-330`, from `add-composite-recall-ranking`). Flagged in
  Impact as the natural follow-on; not built here (see proposal's Impact section for
  why).
- No revision history for `origin`/`confidence`. `memory_revisions`
  (`surface-memory-revision-history`) snapshots `content` only on T0 REVISE, not the
  full record — `importance` and `tags` aren't revisioned today either, so `origin`/
  `confidence` following that same precedent is consistent, not a new gap.
- No audit-log schema change. `LifecycleAuditDetails` (`src/domain/types.ts:194-206`)
  is untouched; this is a content field, not a lifecycle transition.

## Decisions

- **Field split, not a merge into one object.** `confidence` is a plain `number` on
  `MemoryRecord`, not nested inside `origin`, because ranking code (the flagged
  `compositeScore` follow-on) wants a cheap numeric read without unpacking an object,
  matching how `importance` and `access_count` — its future formula-mates — are already
  flat fields.
- **`origin` shape**: `{ session_id?: string; tool?: string; repo?: string; branch?:
  string }`, all optional, `.strict()` in the Zod schema so unknown keys are rejected
  rather than silently dropped. Free-form strings, not enums — MCP has no registry of
  client/tool names (`tool` might be `"claude-code"`, `"codex"`, `"cursor"`, anything),
  and `repo`/`branch` are caller-local facts the server can't validate.
- **Confidence defaults by source, not a single flat default.** `pipeline
  .default_confidence` (new config, `src/config/index.ts`, sibling to the existing
  `pipeline` block at `src/config/index.ts:211-216`) maps each `MemorySource` to a
  default: `cli: 1.0, api: 1.0, agent: 0.7, import: 0.5`. This operationalizes the
  brainstorm's "explicit user statement > agent inference" without requiring every
  caller to compute a per-call value — an agent that never passes `confidence` still
  gets a lower default than a human's direct CLI statement.
- **UPDATE-merge policy mirrors `importance`.** `src/pipeline/index.ts:176` does
  `importance: Math.max(existing.importance, importance)` on merge; `confidence`
  follows the identical `Math.max` policy — a second confirmation should never *lower*
  trust. `origin` cannot be maxed (it's not ordered), so it is replaced only when the
  incoming call supplies a non-null `origin`, otherwise the existing value survives the
  merge — consistent with how `category` and other optional fields already behave
  across UPDATE.
- **Storage encoding**: SQLite stores `origin` as a JSON-serialized `TEXT` column
  (nullable), the same encoding `tags` already uses (`src/storage/sqlite.ts:1668`,
  `JSON.parse(... ?? '[]')`), via a new `parseOrigin` helper that fails soft to `null`
  on corrupt JSON rather than throwing — consistent with the project's general
  fail-soft-on-read posture for optional metadata. `confidence` is a plain `REAL NOT
  NULL DEFAULT 1.0` column — no serialization needed. The Qdrant payload stores `origin`
  as a native nested object (Qdrant payloads are JSON-native; no stringification, same
  as `tags` in `toQdrantPayload`, `src/storage/index.ts:801-830`) and `confidence` as a
  plain number.
- **Legacy rows**: `origin: null`, `confidence: 1.0` (not e.g. `0.5`) — a pre-existing
  memory with no recorded confidence is not evidence of low trust; defaulting it to
  full confidence avoids retroactively demoting the entire existing store the moment
  this migration runs, matching how `embedding_model`'s legacy-NULL rows are treated as
  "unknown" rather than "bad" by mismatch detection.

## Risks / Trade-offs

- **Confidence inflation**: nothing stops a caller from always passing `confidence:
  1.0`. This is the same trust-the-caller posture the project already takes for
  `importance`; no validation beyond the `[0,1]` range is proposed.
- **`origin` is unvalidated free text**: `repo`/`branch`/`tool` values could be
  inconsistent across callers (`"BHGBrain"` vs `"bhgbrain"` vs a full path). Left
  unnormalized deliberately — imposing a canonical form here would require knowledge
  of every client's conventions the server doesn't have; a future change can add
  normalization once real-world values are observed.
- **Migration cost is negligible**: both columns are additive with cheap defaults
  (`NULL`, `1.0`); no backfill pass is required, unlike the embedding `re-embed` path.
- **Config surface growth**: `pipeline.default_confidence` is one more tunable block.
  Mitigated by shipping defaults that need no tuning to be useful, matching the
  `search.ranking` precedent of "sensible defaults, `enabled`-style callers who want
  the old behavior get it for free" (here: omit `confidence` entirely).
