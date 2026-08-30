## Why

The memory type system (`episodic` | `semantic` | `procedural`,
`src/domain/types.ts:1`) mirrors human memory but nothing ever moves between types.
Episodic memories accumulate in T2/T3 forever — each individually decaying per
`MemoryLifecycleService.computeExpiry` (`src/domain/lifecycle.ts:75-80`) and, once
expired, archived to `archived_memories` with only summary/tags/tier retained
(`archiveMemory`, `src/storage/sqlite.ts:1223`) — but a cluster of five related
episodics ("deployed via GitHub Actions", "switched CI to Actions", "Actions runner
pinned to node20", …) never becomes the one durable fact an agent actually needs:
"we deploy via GitHub Actions." The store gets *bigger* with age, not *better*.

The scheduled-job infrastructure this needs already exists and sits idle for this
purpose: `CleanupScheduler` (`src/backup/scheduler.ts:144-206`) runs
`RetentionService.runGc()` on a configurable cron
(`retention.cleanup_schedule`/`retention.scheduled_cleanup_enabled`,
`src/config/index.ts:121-143`), and `RetentionService.runGc`
(`src/backup/retention.ts:50-100`) already has the archive-before-delete,
degraded-on-partial-failure, and audit-logging machinery this feature needs to reuse
rather than reinvent.

What is genuinely missing, and must be built from nothing: there is **no LLM call
path anywhere in this codebase today**. `pipeline.extraction_model` /
`extraction_model_env` are reserved config keys with no runtime effect
(`src/pipeline/index.ts:64-77`, TODO comment confirms extraction is
"deterministic and single-candidate only"); a `grep` for `chat.completions` across
`src/` returns nothing. Distillation is the first feature in this codebase to
actually need a model call, and this proposal has to build that call path itself.

## What Changes

- Add a `retention.distillation` config block (disabled by default) controlling a
  second scheduled job: cron schedule, cluster similarity threshold, minimum/maximum
  cluster size, and a cap on clusters processed per run.
- Add a minimal, narrowly-scoped chat-completion client
  (`src/pipeline/distillation-llm.ts`, new file) that reuses the already-reserved
  `pipeline.extraction_model` / `pipeline.extraction_model_env` config
  (`src/config/index.ts:211-215`) and mirrors `OpenAIEmbeddingProvider`'s
  fetch/circuit-breaker/metrics pattern (`src/embedding/index.ts:35-60`). This client
  does exactly one thing — turn a cluster of episodic memory contents into one
  consolidated semantic-memory draft — and is not general-purpose extraction.
- Add a clustering pass, scoped per namespace/collection, that groups **T2/T3
  `episodic`** memories by cosine similarity over their existing vectors (extending
  `QdrantAdapter.scrollAll`, `src/storage/qdrant.ts:361-386`, to optionally fetch
  vectors) using greedy union-find, not a full pairwise Qdrant search per memory.
- Add `DistillationService`, structurally mirroring `RetentionService`: for each
  qualifying cluster, call the LLM client, write the consolidated memory through the
  existing `WritePipeline.process()` (new `MemorySource` value `'distillation'`,
  `type: 'semantic'`, `retention_tier: 'T1'`), then archive the cluster's source
  memories through the existing `archiveMemory`/`deleteMemories` path — archiving
  only after the distilled memory is confirmed durable.
- Add a `derived_from` field (`string[] | null`, JSON-encoded) on `MemoryRecord`,
  set only on distillation output, naming the archived source memory ids.
- Add a `'DISTILL'` `LifecycleAuditOperation` (`src/domain/types.ts:175`) and extend
  `LifecycleAuditDetails.action` (`src/domain/types.ts:200`) with `'distill'`.
- Wire a second scheduler instance reusing `parseCronExpression`/`nextRunAfter`
  (`src/backup/scheduler.ts:56-136`) against `DistillationService`, started/stopped
  alongside `CleanupScheduler` in `src/index.ts:114-115`.
- Add a `bhgbrain distill` CLI command mirroring `gc` (`src/cli/index.ts:229-236`):
  `--dry-run` prints the clusters that would be distilled without calling the LLM or
  mutating anything.
- Add `bhgbrain_distill_*` counters/histograms (clusters found, distilled, skipped —
  no key / LLM error / below threshold, duration) and a `retention.distillation`
  health rollup, following the existing `bhgbrain_gc_*` pattern
  (`src/backup/retention.ts:182-186`).
- Document the config block, new CLI command, and `derived_from` field in
  `README.md` + the four translations, `.env.example` (no new env var —
  `BHGBRAIN_EXTRACTION_API_KEY` is already documented at `.env.example:26-28`), and
  bump `package.json` version.

This is explicitly the largest, riskiest item surveyed in
`codeaudit/storagefeaturebrainstorm.md` §3.2 ("the most ambitious idea here"), and is
scoped and phased accordingly — see `design.md` for what is deliberately deferred.

## Capabilities

### New Capabilities
- `memory-distillation`: a scheduled job clusters related T2/T3 episodic memories,
  distills each qualifying cluster into a single T1 semantic memory via an LLM call,
  and archives the sources with lineage (`derived_from`) preserved on the result.

### Modified Capabilities
- `tiered-memory-lifecycle`: gains a fifth lifecycle transition (`DISTILL`) alongside
  the existing promote/archive/revise/restore transitions, and a new provenance value
  (`source: 'distillation'`) on the memory record.

## Impact

- Affected code: `src/config/index.ts` (new config block), `src/domain/types.ts` /
  `src/domain/schemas.ts` (`derived_from`, `MemorySource`, `LifecycleAuditOperation`),
  `src/storage/sqlite.ts` (migration column, row hydration, insert/update column
  lists), `src/storage/qdrant.ts` (`scrollAll` vector option), new
  `src/pipeline/distillation-llm.ts` and `src/pipeline/distillation.ts` (or
  `src/backup/distillation.ts`, see `design.md`), `src/backup/scheduler.ts` (reused,
  not modified, unless generalized — see Decisions), `src/cli/index.ts`,
  `src/health/metrics.ts`, `src/index.ts` wiring, co-located tests.
- New runtime dependency: an outbound LLM (chat-completion) call, gated behind
  `retention.distillation.enabled: false` by default and skipped cleanly (counted,
  not fatal) when no API key is configured.
- Depends conceptually on two ideas the brainstorm proposes but that have **no
  OpenSpec change yet**: `add-multi-candidate-extraction` (2.1 — a general
  extraction-model call path) and `add-duplicate-cluster-consolidation` (5.1 — a
  general clustering/consolidation engine). This proposal does not block on either;
  it builds narrowly-scoped, distillation-only versions of both and flags the reuse
  opportunity if those land later (see `design.md` Decisions).
- Also touches on `add-memory-links` (3.1 — generic typed edges), still unproposed;
  this change deliberately does **not** wait for it (see Decisions for why
  `derived_from` ships as a dedicated field instead).
- No schema change to `archived_memories` — sources are archived through the
  existing path unchanged; lineage lives on the new memory, not the archive rows.
