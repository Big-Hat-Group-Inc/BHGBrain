## Why

No vector in the system records which embedding model produced it. `MemoryRecord` has
no model field, the Qdrant payload carries none, and the collection only knows its
dimension count. If an operator changes `embedding.provider` or `embedding.model` in
`config.json`:

- **Same dimensions** (e.g. `text-embedding-3-small` → an Azure deployment of the same
  model family at 1536): nothing detects the change. New vectors land in the same
  collection as old ones; cosine similarity across two different models' spaces is
  meaningless; recall quality silently corrodes and dedup mis-fires (`similar[0]`
  scores become noise fed into the 0.92/0.98 thresholds).
- **Different dimensions**: writes fail at the Qdrant layer with an opaque dimension
  error — better than corruption, but with no guidance.

With two providers already shipping (`openai`, `azure-foundry`) and per-model dimension
configurability, model changes are a supported operation with an unsupported outcome.
This is the classic migration hazard: cheap to prevent now, expensive to untangle
after a store has mixed spaces.

## What Changes

- Stamp embedding provenance at write time: `embedding_model` (provider-qualified,
  e.g. `openai/text-embedding-3-small@1536`) stored on the SQLite row and in the
  Qdrant payload for every new/updated vector.
- Record the collection-level expected identity in SQLite config metadata on first
  write; on startup, compare against the active configuration:
  - mismatch → health `embedding` component degrades with an explicit message, a
    structured warning logs the two identities, and (config-gated) writes can be
    refused to prevent further mixing.
- Add a `re-embed` maintenance path (CLI flag or extension of the existing `repair`
  tool) that re-embeds memories whose stamp differs from the active identity —
  batched, resumable, rate-aware (reusing the bounded-reconciliation patterns from
  `bound-restore-reconciliation`), marking progress via the existing
  `vector_synced` machinery.
- Legacy rows (no stamp) are treated as "unknown"; the re-embed path can
  (config-gated) include them.
- Document model-migration procedure in README ×5 and `AGENTS.md`; bump version.

## Capabilities

### New Capabilities
- `embedding-provenance`: Every vector records the model that produced it, model
  changes are detected at startup and surfaced in health, and a bounded re-embed
  migration brings the store to a single vector space.

### Modified Capabilities

## Impact

- Affected code: `src/domain/types.ts` (+`embedding_model`), `src/storage/sqlite.ts`
  (column + migration), `src/storage/qdrant.ts` (payload), `src/pipeline/index.ts`
  (stamping), `src/health/index.ts` (mismatch surfacing), `src/tools/index.ts` /
  `src/cli/index.ts` (re-embed entry point), tests.
- Storage: additive SQLite column with NULL for legacy rows; additive payload field.
- Cost: re-embedding a large store calls the paid embedding API per memory — the
  migration is explicitly operator-initiated, never automatic.
- Docs: README ×5, `AGENTS.md` (embedding provider section), version bump.
