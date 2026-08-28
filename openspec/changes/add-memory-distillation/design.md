## Context

Verified against the current branch (post `push-down-recall-filters`,
`add-composite-recall-ranking`, `stamp-embedding-provenance`,
`surface-memory-revision-history`, `upgrade-fulltext-to-fts5`,
`add-relevance-conditioned-inject`, `add-review-and-archive-recall`):

- **Type system is static.** `MemoryType = 'episodic' | 'semantic' | 'procedural'`
  (`src/domain/types.ts:1`). Nothing in `src/pipeline/index.ts` or
  `src/storage/sqlite.ts` ever rewrites a memory's `type`.
- **Lifecycle is per-memory, not per-cluster.** `MemoryLifecycleService`
  (`src/domain/lifecycle.ts`) assigns a tier at write time (`assignTier`) and
  computes expiry (`computeExpiry`); `RetentionService.runGc`
  (`src/backup/retention.ts:50-100`) archives/deletes T2/T3 memories individually
  once expired, via `archiveMemory` (`src/storage/sqlite.ts:1223`), which persists
  only `summary`/`tags`/`tier`/`access_count` into `archived_memories` — full
  `content` is dropped on archive. This is why distillation must read source content
  *before* archiving, not after.
- **`CleanupScheduler` is a general cron runner in shape, not in code.**
  `src/backup/scheduler.ts:144-206` hard-codes a call to
  `RetentionService.runGc()` in `runOnce()`. The cron-parsing helpers
  (`parseCronExpression`, `nextRunAfter`, lines 56-136) are pure functions with no
  dependency on `RetentionService` and are directly reusable; the `CleanupScheduler`
  class itself is not (it is not parametrized over the job to run).
- **No LLM call path exists.** `pipeline.extraction_model` /
  `extraction_model_env` (`src/config/index.ts:211-215`) are read by nothing.
  `src/pipeline/index.ts:64-77`'s `extract()` is fully deterministic, single-candidate,
  and the surrounding comment says so explicitly. `grep -rn "chat.completions"
  src/` returns zero hits. The only outbound-HTTP-to-a-model precedent is
  `OpenAIEmbeddingProvider` (`src/embedding/index.ts:35-60`), a `fetch` against
  `https://api.openai.com/v1/...` with a circuit breaker and metrics — a good
  template for shape, not reusable code (it calls `/embeddings`, distillation needs
  `/chat/completions`).
- **Clustering has no existing engine.** `QdrantAdapter.scrollAll`
  (`src/storage/qdrant.ts:361-386`) pages every point in a collection but calls
  `scroll` with `with_vector: false` — it returns payload only, not the vectors
  needed to cluster. No pairwise-similarity or union-find code exists anywhere in
  `src/`.
- **Lineage precedent exists but is singular.** `merged_from: string | null`
  (`src/domain/types.ts:56`) records one UPDATE-time predecessor. Distillation needs
  a memory pointing at *many* sources, which `merged_from`'s shape does not fit.

## Goals / Non-Goals

**Goals**
- Turn clusters of related, still-active T2/T3 `episodic` memories into a single T1
  `semantic` memory that an agent can actually recall as one fact, on a schedule,
  reusing existing archive/audit/scheduler machinery wherever its shape fits.
- Ship in phases that are each independently mergeable and testable: schema/config
  first, clustering (no LLM) second — verifiable and dry-runnable with zero model
  cost — LLM-backed distillation third.
- Fail safe: no source memory is ever archived unless its replacement was durably
  written first; no LLM key configured means clusters are skipped and counted, never
  a hard failure of the scheduled job or of `gc`.
- Off by default (`retention.distillation.enabled: false`), so existing installs are
  unaffected until an operator opts in and provisions an extraction API key.

**Non-Goals**
- Not general multi-candidate extraction (`remember`-time splitting of one write
  into several atomic facts) — that is `add-multi-candidate-extraction` (2.1),
  unproposed, and a different code path (`WritePipeline.extract`, not this job).
- Not a general duplicate-cluster consolidation/audit tool — that is
  `add-duplicate-cluster-consolidation` (5.1), unproposed. This proposal's
  clustering pass is intentionally narrow (T2/T3 episodic only, high similarity
  threshold) rather than a general near-duplicate finder across all tiers/types.
- Not a generic typed-edges/relationship graph — that is `add-memory-links` (3.1),
  unproposed. `derived_from` here is a single-purpose lineage field, not a step
  toward a `memory_links` table.
- No human-in-the-loop review/approval step before a cluster is distilled and
  archived. `add-review-and-archive-recall`'s `review` tool (already built) covers
  T1 review post-hoc; a pre-distillation approval queue is future work (see Risks).
- No cross-namespace or cross-collection clustering; no `semantic`/`procedural`
  source memories; no T0/T1 sources.
- No contradiction resolution — if the cluster contains conflicting facts, the LLM
  prompt asks it to prefer the most recent (`updated_at`) memory, but true
  entailment-based contradiction detection is `add-relevance-conditioned-inject`'s
  sibling idea (2.4), out of scope here.

## Decisions

**1. Build narrow, self-contained versions of the two missing subsystems rather
than block on their (currently unproposed) siblings.**
`add-multi-candidate-extraction` and `add-duplicate-cluster-consolidation` are
brainstorm ideas with no OpenSpec change directory. Waiting for them would make
this proposal indefinitely blocked. Instead:
  - The LLM client (`src/pipeline/distillation-llm.ts`) does one job — cluster
    contents in, one consolidated draft out — via a single `/chat/completions` call.
    It is not a general extraction interface.
  - The clustering pass does one job — group same-namespace/collection/type/tier
    vectors by cosine ≥ threshold via greedy union-find over an in-memory scroll.
    It is not a general audit/report tool.
  If either sibling proposal lands later, its more general engine should absorb
  this one (delete the narrow version, call the general one) rather than the two
  living side by side long-term — noted as a follow-up, not committed here.

**2. `derived_from` ships as a dedicated field, not `add-memory-links` typed edges.**
`add-memory-links` (typed `refines`/`contradicts`/`derived_from`/... edges) is
itself unproposed and is a materially larger schema change (a new table, a `relate`
tool, link-following at recall). Distillation needs exactly one directional fact —
"this T1 memory was derived from these N archived memories" — which is:
  - Structurally identical in kind to the existing `merged_from` field
    (`src/domain/types.ts:56`), just multi-valued.
  - Write-once, single-producer (only `DistillationService` ever sets it) — it does
    not need a general edge table's query/traversal machinery.
  Decision: add `derived_from: string[] | null` (JSON-encoded TEXT column, same
  encoding convention as `tags`) directly on `memories`, hydrated in `rowToMemory`
  (`src/storage/sqlite.ts:1659-1687`) next to `merged_from`. If `add-memory-links`
  ships later, `derived_from` can be migrated into a `derived_from` edge type there;
  this proposal does not need to anticipate that shape.

**3. Clustering scope: same namespace + collection + `type: 'episodic'` + tier in
`{T2, T3}`, via one `scrollAll`-with-vectors pass per collection, not pairwise
Qdrant `search` calls.** Fetching all candidate vectors once and clustering in
memory (greedy union-find, cosine ≥ `retention.distillation.similarity_threshold`)
is O(n) Qdrant round-trips instead of O(n²); acceptable because T2/T3 episodic
volume per collection is bounded by `retention.tier_budgets` (`src/config/
index.ts:135-139`, default 200,000 each) and clustering runs on its own low-frequency
cron, not the hot read path. `QdrantAdapter.scrollAll` gains an optional
`withVector` parameter rather than a new method, to avoid duplicating pagination
logic.

**4. Archive only after the distilled memory is durably written; skip (don't fail)
on missing key or LLM error.** Mirrors `RetentionService.runGc`'s
archive-before-delete discipline (`src/backup/retention.ts:109-141`): write the T1
memory through `WritePipeline.process()` first; only on success does
`DistillationService` archive+delete the cluster's sources via the existing
`archiveMemory`/`storage.deleteMemories` path. If the LLM call throws, or
`process.env[extraction_model_env]` (falling back to `OPENAI_API_KEY`, matching
`.env.example:26-28`) is unset, the cluster is skipped: logged, counted in
`bhgbrain_distill_skipped_total{reason}`, and the job continues to the next cluster.
A skip is not a `degraded` condition (unlike GC's archive/delete failures) — an
operator who hasn't configured an extraction key has simply not opted into this
feature's LLM half yet, and Phase 1 (see Risks) is designed to be useful without it.

**5. Reuse the scheduler's cron math, not its class.** `parseCronExpression` and
`nextRunAfter` (`src/backup/scheduler.ts:56-136`) are pure and reusable as-is. Rather
than force `CleanupScheduler` to become generic over an arbitrary job (a larger,
riskier refactor of code three other proposals also touch), this change adds a
second, structurally similar scheduler instance constructed the same way
(`retention.distillation.schedule` cron string, its own `setTimeout`/self-reschedule
loop) that calls `DistillationService.runOnce()`. If a third scheduled job appears
later, that is the trigger to generalize `CleanupScheduler` into `CronJobRunner<T>` —
not now, for two jobs.

**6. New `MemorySource: 'distillation'` and `LifecycleAuditOperation: 'DISTILL'`.**
Reusing `source: 'agent'` for distillation output would make it indistinguishable
from agent-authored writes in every provenance-sensitive place (ranking, audit,
`add-review-and-archive-recall`'s review queue). A dedicated enum value
(`MemorySourceSchema`, `src/domain/schemas.ts:8`) is a one-line addition with no
knock-on schema cost, and lets `MemoryLifecycleService.assignTier`
(`src/domain/lifecycle.ts:46-61`) remain untouched — `DistillationService` calls
`WritePipeline.process()` with `retention_tier: 'T1'` explicit, which
`assignTier`'s first line already honors (`if (input.explicitTier) return
input.explicitTier;`), so no new branch is needed there.

**7. Write the distilled memory through `WritePipeline.process()`, not a raw
insert.** This gets checksum dedup, embedding, audit logging, and tier assignment
for free, and — importantly — means a second distillation run over a
still-overlapping cluster produces an UPDATE against the prior distilled memory
instead of a duplicate T1 row, using the exact same similarity-based
`classifyOperation` logic (`src/pipeline/index.ts`) every other write goes through.

## Risks / Trade-offs

- **Phasing is load-bearing, not cosmetic.** Phase 1 (schema, config, clustering,
  `--dry-run` CLI) ships with zero LLM dependency and is fully testable/mergeable on
  its own — clusters are found and printed, nothing is written or archived. Phase 2
  adds the live LLM call. Shipping Phase 1 alone still has value (an operator can see
  *what* would be distilled) and de-risks the larger change by letting clustering
  correctness be reviewed independently of prompt/model behavior.
- **Content loss is irreversible.** `archiveMemory` keeps only summary/tags/tier —
  once sources are archived, their full content is gone even if the distilled
  summary later proves wrong or incomplete. Mitigated by: `enabled: false` default,
  conservative `similarity_threshold` (recommend 0.85) and `min_cluster_size`
  (recommend 3) defaults so weakly-related memories are never merged, and
  `archive_before_delete` (already `true` by default) still applying — but there is
  no undo for a bad distillation the way `surface-memory-revision-history` gives
  UPDATE. A future `review`-tool gate (5.2 already ships a `review` tool for T1;
  extending it to a pre-archive distillation approval queue is natural follow-up
  work, explicitly deferred here).
- **LLM cost, latency, and nondeterminism.** Every qualifying cluster is one model
  call; `max_clusters_per_run` bounds worst-case cost per scheduled tick. Model
  output is not guaranteed high-quality — a bad consolidation is possible and, per
  the point above, not easily reversible.
- **False merges from the similarity-only clustering.** Cosine similarity clusters
  topically similar content, not necessarily factually consistent content ("we use
  MySQL" and "we migrated off MySQL" can sit close in embedding space while
  contradicting each other). The LLM prompt is asked to prefer the most recent
  memory when sources conflict, but this is a mitigation, not a guarantee — genuine
  contradiction detection is out of scope (see Non-Goals).
- **Self-reinforcing feedback with composite ranking.** A freshly distilled T1
  memory has `access_count: 0` and `updated_at: now`, which — combined with
  `add-composite-recall-ranking`'s T1 decay/weighting — can make it under-rank
  relative to the very episodics it just replaced (which may have accumulated
  access history) until it earns its own access count. Acceptable at ship time;
  worth revisiting once `search.ranking` (already shipped) has real distillation
  output to observe.
- **Duplication risk with `add-duplicate-cluster-consolidation` if it lands
  independently.** Flagged in Decisions #1 — accepted as a deliberate trade-off of
  not blocking on an unproposed sibling.
