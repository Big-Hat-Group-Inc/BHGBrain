## 1. Schema & config (Phase 1 — no LLM dependency)

- [ ] 1.1 Add `derived_from: string[] | null` to `MemoryRecord`
  (`src/domain/types.ts:37-69`, next to `merged_from` at line 56) and to
  `MemoryRecordWithoutEmbedding` if it is a distinct type in
  `src/storage/sqlite.ts`.
- [ ] 1.2 Add `'DISTILL'` to `LifecycleAuditOperation` (`src/domain/types.ts:175`)
  and `'distill'` to `LifecycleAuditDetails['action']` (`src/domain/types.ts:200`).
- [ ] 1.3 Add `'distillation'` to `MemorySource` (`src/domain/types.ts:5`) and
  `MemorySourceSchema` (`src/domain/schemas.ts:8`).
- [ ] 1.4 Add a `derived_from TEXT` column to the migration list in
  `src/storage/sqlite.ts` (`requiredColumns` array, ~line 1816-1825, following the
  existing `embedding_model` entry at line 1824) and to the `CREATE TABLE memories`
  DDL (~line 192-197) for fresh databases.
- [ ] 1.5 Thread `derived_from` through `rowToMemory` (`src/storage/sqlite.ts:1659-
  1687`, JSON-parsed like `tags` at line 1668, nullable like `merged_from` at line
  1678) and through the insert/update column lists (~lines 466, 486, 556) —
  `JSON.stringify(derived_from)` or `null`.
- [ ] 1.6 Add `retention.distillation` to the Zod config schema
  (`src/config/index.ts`, alongside the `retention` block at lines 121-143):
  `enabled` (default `false`), `schedule` (cron string, default `'0 3 * * *'` — one
  hour after `cleanup_schedule`'s default `'0 2 * * *'`), `similarity_threshold`
  (default `0.85`), `min_cluster_size` (default `3`), `max_cluster_size` (default
  `20`), `max_clusters_per_run` (default `10`).
- [ ] 1.7 Confirm no new env var is needed: `retention.distillation` reuses
  `pipeline.extraction_model` / `pipeline.extraction_model_env`
  (`src/config/index.ts:211-215`, already documented at `.env.example:26-28`).

## 2. Clustering engine (Phase 1 — no LLM dependency)

- [ ] 2.1 Extend `QdrantAdapter.scrollAll` (`src/storage/qdrant.ts:361-386`) with an
  optional `withVector: boolean` parameter (default `false`, preserving existing
  callers) that sets `with_vector: true` in the `scroll` call and returns `vector`
  alongside `id`/`payload`.
- [ ] 2.2 Add `src/pipeline/distillation-cluster.ts`: given a namespace+collection's
  T2/T3 `episodic` memory ids+vectors (fetched via SQLite's tier/type filter joined
  with the scrolled vectors, or a payload-filtered scroll), compute connected
  components with cosine similarity ≥ `similarity_threshold` using greedy
  union-find; return clusters with `min_cluster_size ≤ size ≤ max_cluster_size`,
  capped at `max_clusters_per_run` (largest/most-cohesive first).
- [ ] 2.3 Unit tests for `distillation-cluster.ts`: disjoint clusters, a
  below-threshold pair stays separate, a cluster below `min_cluster_size` is
  dropped, a cluster above `max_cluster_size` is capped or split (define and test
  the chosen behavior), `max_clusters_per_run` truncates deterministically.

## 3. LLM distillation client (Phase 2)

- [ ] 3.1 Add `src/pipeline/distillation-llm.ts`: a `DistillationLLMClient` mirroring
  `OpenAIEmbeddingProvider`'s constructor/circuit-breaker/metrics shape
  (`src/embedding/index.ts:35-60`) but calling `POST
  https://api.openai.com/v1/chat/completions` with `pipeline.extraction_model`,
  reading the key from `process.env[pipeline.extraction_model_env]` (fallback
  `OPENAI_API_KEY`, matching the documented behavior at `README.md:519`). Throws a
  typed, catchable error (not a raw fetch rejection) on missing key, non-2xx, or
  unparseable response — `DistillationService` treats all three as "skip this
  cluster", never a crash.
- [ ] 3.2 Define the prompt contract: input = cluster's memory contents (oldest to
  newest) + their `updated_at`; output = one consolidated fact
  (a JSON object `{ content: string, summary: string }`, validated with the
  existing `content`/summary constraints — summary ≤ 120 chars, matching
  `generateSummary`'s contract in `src/domain/normalize.ts`). Instruct the model to
  prefer the most recently updated source on conflicting facts (see design.md
  Non-Goals — this is a mitigation, not contradiction detection).
- [ ] 3.3 Unit tests for `distillation-llm.ts` with a mocked `fetch`: success path,
  missing-key path (no network call made), non-2xx response, malformed JSON
  response, response missing required fields — all resolve to the typed skip error
  except the success path.

## 4. DistillationService (Phase 2)

- [ ] 4.1 Add `src/pipeline/distillation.ts` (or `src/backup/distillation.ts` —
  match whichever the reviewer prefers for the retention/pipeline boundary;
  `RetentionService` lives in `src/backup/`, but this needs `WritePipeline` from
  `src/pipeline/`, so place per the lower-dependency direction): `DistillationService`
  constructed with `(config, storage, writePipeline, llmClient, logger?, metrics?)`.
- [ ] 4.2 `runOnce(options?: { dryRun?: boolean })`: for each eligible
  namespace+collection (T2/T3 episodic memories present), find clusters (§2),
  and for each cluster:
  - `dryRun: true` — record the cluster (ids, summaries) as a candidate, make no
    LLM call, write nothing.
  - otherwise — call `DistillationLLMClient`; on failure, record as skipped
    (`reason: 'llm_error' | 'no_key'`) and continue; on success, write the
    consolidated memory via `WritePipeline.process()` with `source: 'distillation'`,
    `type: 'semantic'`, `retention_tier: 'T1'`, `derived_from: <cluster ids>`.
- [ ] 4.3 On a confirmed write, archive the cluster's source memories through the
  existing `storage.sqlite.archiveMemory` + `storage.deleteMemories` path
  (mirroring `src/backup/retention.ts:109-168`), logging a `DISTILL` audit entry
  per `LifecycleAuditDetails` (`action: 'distill'`) referencing both the new memory
  id and the archived source ids.
- [ ] 4.4 Failure handling: if archival/deletion of sources fails after a
  successful distilled write, do **not** roll back the write (mirrors GC's
  no-partial-rollback stance) — log and count as degraded, leaving sources active
  (safe: a still-active source just means the next clustering run may re-cluster
  it, and `WritePipeline.process()`'s dedup will UPDATE rather than duplicate the
  T1 memory).
- [ ] 4.5 Return a `DistillationResult` (mirroring `GarbageCollectionResult`,
  `src/backup/retention.ts:8-36`): `clustersFound`, `distilled`, `skipped: {reason,
  count}[]`, `archived`, `degraded`, `candidates` (dry-run/non-dry-run cluster
  summaries).
- [ ] 4.6 Integration tests: end-to-end cluster → distill → archive happy path;
  no-key skip; LLM-error skip; a cluster that re-forms after a prior distillation
  UPDATEs rather than duplicates; archive failure leaves sources active and marks
  degraded; dry-run performs no writes/archives/LLM calls.

## 5. Scheduler wiring & CLI

- [ ] 5.1 Add a `DistillationScheduler` in `src/backup/scheduler.ts` (or a sibling
  file) reusing `parseCronExpression`/`nextRunAfter` (lines 56-136) with the same
  start/stop/self-reschedule shape as `CleanupScheduler` (lines 144-206), driven by
  `retention.distillation.schedule` / `retention.distillation.enabled` and calling
  `DistillationService.runOnce()`.
- [ ] 5.2 Wire it in `src/index.ts` alongside the existing
  `cleanupScheduler`/`retentionService` construction (lines 114-115): construct
  `DistillationService` and `DistillationScheduler`, call `.start()`/`.stop()`
  wherever `cleanupScheduler` is started/stopped.
- [ ] 5.3 Add a `bhgbrain distill` CLI command in `src/cli/index.ts`, mirroring the
  `gc` command (lines 229-236): `--dry-run` flag, prints cluster candidates and
  (when not dry-run) distillation/skip/archive counts.
- [ ] 5.4 CLI test coverage mirroring `src/cli/index.test.ts`'s existing `gc`
  coverage (around line 234): dry-run prints candidates without invoking the LLM
  client; live run reports the `DistillationResult` summary.

## 6. Metrics & health

- [ ] 6.1 Add `bhgbrain_distill_duration_ms` (histogram),
  `bhgbrain_distill_clusters_found_total`, `bhgbrain_distill_distilled_total`,
  `bhgbrain_distill_archived_total`, `bhgbrain_distill_skipped_total{reason}`
  counters, following the `bhgbrain_gc_*` pattern in `src/backup/retention.ts:182-
  186`.
- [ ] 6.2 Add a `distillation` field to the retention health snapshot
  (`HealthSnapshot.retention`, `src/domain/types.ts:155-164`): last-run timestamp,
  last-run degraded flag, cumulative distilled/skipped counts — additive, no
  breaking change to existing `retention` health consumers.

## 7. Tests (cross-cutting)

- [ ] 7.1 `MemoryLifecycleService`/`assignTier` regression: `explicitTier: 'T1'`
  with `source: 'distillation'` still resolves to `T1` (confirms no new branch is
  needed per design.md Decision #6).
- [ ] 7.2 `rowToMemory`/insert round-trip test for `derived_from`: write, read back,
  `null` for ordinary writes, populated array for distillation writes.
- [ ] 7.3 `search`/`recall` regression: a distilled memory (`source:
  'distillation'`) ranks, filters, and displays like any other T1 semantic memory —
  no special-casing leaks into the read path.

## 8. Validation

- [ ] 8.1 `npm run lint` (tsc --noEmit + eslint, no `any` casts — model
  `derived_from`, LLM response parsing, and cluster types properly).
- [ ] 8.2 `npm test` — all new and existing suites pass.
- [ ] 8.3 Update `README.md` § MCP surface / config reference (new
  `retention.distillation` block, new `bhgbrain distill` CLI command, `derived_from`
  field) and mirror into `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md`.
- [ ] 8.4 Update `AGENTS.md` if the config-vs-environment section needs a note
  (it does not — no new env var, per task 1.7).
- [ ] 8.5 Bump `package.json` `version` (user-visible: new CLI command, new config
  block, new memory field).
