/**
 * One composition root for the full tool/resource dependency graph — every
 * provider, circuit breaker, storage layer, and service a `ToolContext`
 * needs — built exactly once and shared by both the server entrypoint
 * (`src/index.ts`) and the CLI entrypoint (`src/cli/index.ts`).
 *
 * Before this existed, `main()` and `createContext()` independently
 * hand-built two structurally different graphs: the CLI's omitted
 * `metrics` on `QdrantStore`, never constructed a query-expansion or rerank
 * provider, built `WritePipeline`/`SearchService` with fewer arguments
 * (silently degrading contradiction detection and reranking to "off" no
 * matter the configuration), used SQLite's default busy-timeout instead of
 * `storage.sqlite_busy_timeout_ms`, and never ran the Qdrant hydration
 * bootstrap at all — so the same tool invoked over the CLI and over MCP
 * could silently behave differently even with identical configuration.
 * `buildToolContext` is the single place that graph is assembled, so the
 * two entrypoints can no longer drift apart (align-runtime-entrypoint-
 * contracts task 2.1; design.md decision 1).
 *
 * Deliberately excluded — genuinely transport-specific, not part of the
 * shared tool/resource graph: the HTTP listener/Express app, the MCP
 * `Server`/transport, and the shutdown/signal-handling machinery. Starting
 * `cleanupScheduler`/`distillationScheduler` is also left to the caller
 * (`.start()` is not called here) — the CLI is a one-shot process that must
 * never arm an ongoing background timer, and the server itself must not
 * start one before its transport is actually ready (task 3.2).
 */

import type pino from 'pino';
import type { BrainConfig } from './config/index.js';
import { SqliteStore } from './storage/sqlite.js';
import { QdrantStore } from './storage/qdrant.js';
import { StorageManager } from './storage/index.js';
import { createEmbeddingProvider, getEmbeddingBreakerKey, warnIfEmbeddingDegraded } from './embedding/index.js';
import { WritePipeline } from './pipeline/index.js';
import { createExtractionProvider, warnIfExtractionDegraded } from './pipeline/extraction.js';
import { warnIfEntailmentDegraded } from './pipeline/entailment.js';
import { createSummarizationProvider, warnIfSummarizationDegraded } from './summarization/index.js';
import { SearchService } from './search/index.js';
import { createQueryExpansionProvider, warnIfQueryExpansionDegraded } from './search/query-expansion.js';
import { resolveRerankBootstrap } from './rerank/index.js';
import { BackupService } from './backup/index.js';
import { RetentionService } from './backup/retention.js';
import { CleanupScheduler, DistillationScheduler } from './backup/scheduler.js';
import { DistillationService } from './pipeline/distillation.js';
import { DistillationLLMClient, warnIfDistillationDegraded } from './pipeline/distillation-llm.js';
import { HealthService } from './health/index.js';
import { MetricsCollector } from './health/metrics.js';
import { CircuitBreaker } from './resilience/index.js';
import { ResourceHandler } from './resources/index.js';
import type { ToolContext } from './tools/index.js';

export interface BuiltToolContext {
  ctx: ToolContext;
  resources: ResourceHandler;
  cleanupScheduler: CleanupScheduler;
  distillationScheduler: DistillationScheduler;
}

export interface BuildToolContextOptions {
  // Whether the caller intends to call cleanupScheduler.start()/
  // distillationScheduler.start() on the schedulers this returns. Only
  // controls whether HealthService's `schedulers` component reflects their
  // armed state — `cleanupScheduler`/`distillationScheduler` are always
  // returned either way, and `.start()` is never called here regardless
  // (see the module doc comment). Default `true` (the server's shape): a
  // long-running process that starts them right after its transport is
  // ready should have "not armed yet" visibly reported as degraded.
  // The CLI passes `false` — a one-shot process that, by design, never
  // starts an ongoing background timer at all; without this, `bhgbrain
  // health` would report a permanently "degraded: scheduler not armed"
  // status for a condition that was never a problem
  // (align-runtime-entrypoint-contracts task 2.1).
  schedulersManaged?: boolean;
}

export async function buildToolContext(
  config: BrainConfig,
  logger: pino.Logger,
  options?: BuildToolContextOptions,
): Promise<BuiltToolContext> {
  const schedulersManaged = options?.schedulersManaged ?? true;
  // Initialize storage
  const sqlite = new SqliteStore(config.data_dir!, {
    busyTimeoutMs: config.storage.sqlite_busy_timeout_ms,
  });
  await sqlite.init();
  // openspec/changes/upgrade-fulltext-to-fts5, task 3.3 (visibility half): a
  // structured log (in addition to the health `sqlite` component message) so the
  // legacy-fulltext-fallback condition is visible in logs without polling /health.
  if (!sqlite.isFts5Available()) {
    logger.warn({
      event: 'fts5_unavailable',
      message: 'SQLite build has no fts5 module; fulltext search is running the legacy LIKE-based matcher.',
    });
  }

  const breakerOptions = {
    failureThreshold: config.resilience.circuit_breaker.failure_threshold,
    openWindowMs: config.resilience.circuit_breaker.open_window_ms,
    halfOpenProbeCount: config.resilience.circuit_breaker.half_open_probe_count,
  };
  const embeddingBreakerKey = getEmbeddingBreakerKey(config.embedding.provider);
  const embeddingBreaker = new CircuitBreaker({ ...breakerOptions, key: embeddingBreakerKey, logger });
  const qdrantBreaker = new CircuitBreaker({ ...breakerOptions, key: 'qdrant', logger });
  // Not included in HealthService's `breakers` record below (see
  // add-multi-candidate-extraction design.md): extraction is a best-effort
  // enhancement with a fully-functional fallback, so an open extraction
  // breaker should not degrade the server's aggregate health status. It
  // still gets `logger` so state transitions are visible in structured logs.
  const extractionBreaker = new CircuitBreaker({ ...breakerOptions, key: 'extraction', logger });
  // Independent breaker instance (own failure/half-open state) sharing the
  // `extraction` label with `extractionBreaker`: both wrap chat-completion
  // calls against the same `pipeline.extraction_model`/`extraction_model_env`
  // credential (add-multi-query-expansion design.md "Phase 2 client shape"),
  // but a failing paraphrase/HyDE call must not trip the breaker guarding the
  // write-pipeline's extraction call, or vice versa.
  const queryExpansionBreaker = new CircuitBreaker({ ...breakerOptions, key: 'extraction', logger });
  // Same rationale/independent-instance pattern as `queryExpansionBreaker`
  // (unify-llm-client-boundaries task 2.1): contradiction detection reuses
  // `pipeline.extraction_model`/`extraction_model_env` credentials, so it
  // shares the `extraction` label for reporting, but a failing entailment
  // call must not trip the breaker guarding multi-candidate extraction, or
  // vice versa. Not included in `healthBreakers` below — same best-effort/
  // fail-open rationale as extraction/summarization/query expansion.
  const entailmentBreaker = new CircuitBreaker({ ...breakerOptions, key: 'extraction', logger });
  // Always constructed (cheap, stateless until used) so it exists regardless
  // of `search.rerank.enabled`, mirroring `embeddingBreaker`/`qdrantBreaker`
  // (add-opt-in-rerank-stage design.md "Bootstrap wiring"). Only added to
  // `HealthService`'s breakers map below when a live provider is actually
  // constructed, so `health://status` reports it exactly when reranking is
  // configured.
  const rerankBreaker = new CircuitBreaker({ ...breakerOptions, key: 'rerank', logger });
  // Not included in HealthService's `breakers` record below, same rationale
  // as `extractionBreaker`/`summarizationBreaker`: distillation is off by
  // default and, when enabled, a failing LLM call degrades that scheduled
  // job's own result (surfaced via `retention.distillation` health), not the
  // server's aggregate health status. See add-memory-distillation.
  const distillationBreaker = new CircuitBreaker({ ...breakerOptions, key: 'distillation', logger });
  const metrics = new MetricsCollector(config);
  const qdrant = new QdrantStore(config, qdrantBreaker, logger, metrics);
  const embedding = createEmbeddingProvider(config, { breaker: embeddingBreaker, metrics });
  warnIfEmbeddingDegraded(embedding, config, logger);
  const extraction = createExtractionProvider(config, { breaker: extractionBreaker, metrics, logger });
  warnIfExtractionDegraded(extraction, config, logger);
  // Not included in HealthService's `breakers` record below, same rationale as
  // `extractionBreaker`: summarization is a best-effort enhancement with a
  // fully-functional (extractive) fallback, so an open breaker here should
  // not degrade the server's aggregate health status.
  const summarizationBreaker = config.pipeline.summarization_enabled
    ? new CircuitBreaker({ ...breakerOptions, key: 'summarization', logger })
    : undefined;
  const summarization = createSummarizationProvider(config, { breaker: summarizationBreaker, metrics });
  warnIfSummarizationDegraded(summarization, config, logger);
  // Not included in HealthService's `breakers` record below, same rationale as
  // `extractionBreaker`/`summarizationBreaker`: query expansion phase 2 is a
  // best-effort enhancement — search degrades to phase-1 variants on any
  // failure — so an open breaker here should not degrade the server's
  // aggregate health status.
  const queryExpansion = createQueryExpansionProvider(config, { breaker: queryExpansionBreaker, metrics, logger });
  warnIfQueryExpansionDegraded(queryExpansion, config, logger);
  warnIfEntailmentDegraded(config, logger);
  // Only instantiated when reranking is opted in (add-opt-in-rerank-stage):
  // stock installs never construct a `RerankProvider`, so `SearchService`
  // gets `undefined` and `recall` stays byte-for-byte unchanged. Enabling it
  // with a missing/invalid `search.rerank.model_env` value falls back to the
  // degraded provider (logged below) rather than crashing startup. Extracted
  // to `resolveRerankBootstrap` (task 5.6) so this wiring is unit-testable
  // without instantiating the rest of this dependency graph.
  const { rerank, healthBreaker: rerankHealthBreaker } = resolveRerankBootstrap(config, {
    breaker: rerankBreaker,
    metrics,
    logger,
  });
  const storage = new StorageManager(sqlite, qdrant, embedding, metrics, config, summarization);

  // Bootstrap: hydrate SQLite from Qdrant, resuming any collection not yet
  // recorded 'complete' in bootstrap_hydration_state. Unconditional on every
  // call — not gated on countMemories() === 0 — because a non-zero local
  // row count (even from just one previously-successful collection) must
  // never suppress retrying collections that failed or were never attempted
  // (align-runtime-entrypoint-contracts task 3.1). `skipCompleted: true`
  // keeps this cheap in the common steady-state case: collections already
  // marked 'complete' are not rescrolled, so a fully-hydrated store only
  // pays for a Qdrant collection-list call, not a full rescan, on every call
  // — including every CLI invocation, not just server startup (task 2.1:
  // the CLI previously never ran this hydration at all, so its view of
  // stored data could silently lag behind the MCP server's).
  try {
    const hydrated = await storage.bootstrapFromQdrant(logger, { skipCompleted: true });
    if (hydrated > 0) {
      logger.info({ event: 'bootstrap', message: `[bootstrap] hydrated ${hydrated} memories from Qdrant` });
    }
  } catch (err) {
    logger.warn({ event: 'bootstrap_error', message: `[bootstrap] failed to hydrate from Qdrant: ${(err as Error).message}` });
  }

  // Embedding provenance: if the store already adopted an expected identity
  // and it differs from the active configuration, log it loudly (rather
  // than only surfacing it lazily on the next health poll or write attempt)
  // — see embedding-provenance.
  const expectedEmbeddingIdentity = storage.getExpectedEmbeddingIdentity();
  if (expectedEmbeddingIdentity && expectedEmbeddingIdentity !== embedding.identity) {
    logger.warn({
      event: 'embedding_identity_mismatch',
      expected_identity: expectedEmbeddingIdentity,
      active_identity: embedding.identity,
      refuse_writes: config.embedding.refuse_writes_on_model_mismatch,
      message: `Embedding identity changed: store expects "${expectedEmbeddingIdentity}" but active ` +
        `configuration is "${embedding.identity}". Run the repair tool with mode: "re-embed" to migrate.`,
    });
  }

  // Initialize services
  const pipeline = new WritePipeline(config, storage, embedding, logger, extraction, metrics, summarization, entailmentBreaker);
  const searchService = new SearchService(config, storage, embedding, metrics, logger, queryExpansion, rerank);
  const backupService = new BackupService(config, storage, logger);
  const healthBreakers: Record<string, CircuitBreaker> = {
    [embeddingBreakerKey]: embeddingBreaker,
    qdrant: qdrantBreaker,
  };
  // Reported in `health://status` only when a live (non-degraded) rerank
  // provider was actually constructed, so an open breaker here degrades
  // aggregate health precisely when reranking is configured and failing —
  // not on every stock install where reranking is off.
  if (rerankHealthBreaker) {
    healthBreakers.rerank = rerankHealthBreaker;
  }
  // Scheduled cleanup: same execution path as `bhgbrain gc`, run on
  // `retention.cleanup_schedule` for the lifetime of a long-running server
  // process. `.start()` is deliberately NOT called here: constructing the
  // scheduler (and HealthService's getState() closure over it, below) does
  // not itself schedule anything — only the caller decides whether/when to
  // arm it (task 2.1/3.2). The CLI never calls `.start()` at all (a one-shot
  // process must not arm an ongoing timer); the server calls it only once
  // its transport is actually ready.
  const retentionService = new RetentionService(config, storage, logger, metrics);
  const cleanupScheduler = new CleanupScheduler(config, retentionService, logger);

  // Scheduled distillation: clusters related T2/T3 episodic memories and
  // consolidates each qualifying cluster into one T1 semantic memory. Off by
  // default (`retention.distillation.enabled: false`); the scheduler itself
  // is a no-op start() when disabled, mirroring `cleanupScheduler` above. See
  // add-memory-distillation. `.start()` deferred for the same reason as
  // cleanupScheduler above.
  const distillationLlmClient = new DistillationLLMClient(config, distillationBreaker, metrics);
  const distillationService = new DistillationService(config, storage, pipeline, distillationLlmClient, logger, metrics);
  const distillationScheduler = new DistillationScheduler(config, distillationService, logger);
  warnIfDistillationDegraded(config, logger);

  const healthService = new HealthService(
    storage, embedding, config, healthBreakers, logger,
    // Omitted entirely (rather than passed as a closure that just returns
    // `[]`) when the caller never intends to start these schedulers at all
    // (schedulersManaged: false — the CLI) — checkSchedulers() then reports
    // schedulers as healthy rather than degraded for a state that, for a
    // one-shot process, was never actually a problem.
    schedulersManaged
      ? (
        // A disabled schedule is intentionally unarmed. Only configured
        // schedules participate in health, where an unarmed/failed state
        // signals a real scheduling problem rather than an opted-out
        // feature.
        () => [
          ...(config.retention.scheduled_cleanup_enabled ? [cleanupScheduler.getState()] : []),
          ...(config.retention.distillation.enabled ? [distillationScheduler.getState()] : []),
        ]
      )
      : undefined,
  );

  const ctx: ToolContext = {
    config, storage, embedding, pipeline,
    search: searchService, backup: backupService,
    health: healthService, metrics, logger,
  };

  const resources = new ResourceHandler(config, storage, searchService, healthService);

  return { ctx, resources, cleanupScheduler, distillationScheduler };
}
