#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, ensureDataDir } from './config/index.js';
import { SqliteStore } from './storage/sqlite.js';
import { QdrantStore } from './storage/qdrant.js';
import { StorageManager } from './storage/index.js';
import { createEmbeddingProvider, getEmbeddingBreakerKey, warnIfEmbeddingDegraded } from './embedding/index.js';
import { WritePipeline } from './pipeline/index.js';
import { createExtractionProvider, warnIfExtractionDegraded } from './pipeline/extraction.js';
import { createSummarizationProvider, warnIfSummarizationDegraded } from './summarization/index.js';
import { SearchService } from './search/index.js';
import { createQueryExpansionProvider, warnIfQueryExpansionDegraded } from './search/query-expansion.js';
import { resolveRerankBootstrap } from './rerank/index.js';
import { BackupService } from './backup/index.js';
import { RetentionService } from './backup/retention.js';
import { CleanupScheduler, DistillationScheduler } from './backup/scheduler.js';
import { DistillationService } from './pipeline/distillation.js';
import { DistillationLLMClient } from './pipeline/distillation-llm.js';
import { HealthService } from './health/index.js';
import { MetricsCollector } from './health/metrics.js';
import { createLogger } from './health/logger.js';
import { CircuitBreaker } from './resilience/index.js';
import { ResourceHandler } from './resources/index.js';
import type { ToolContext } from './tools/index.js';
import { createHttpServer, applyHttpServerTimeouts } from './transport/http.js';
import { buildMcpServer } from './transport/mcp-server.js';
import type pino from 'pino';

/** Milliseconds a shutdown drain is given before the hard deadline forces exit. */
const SHUTDOWN_DEADLINE_MS = 10_000;

interface ShutdownDeps {
  logger: pino.Logger;
  sqlite: SqliteStore;
  cleanupScheduler: CleanupScheduler;
  distillationScheduler: DistillationScheduler;
  transport: 'http' | 'stdio';
  /**
   * Transport-specific drain step: for HTTP, close live MCP sessions then the
   * listener; for stdio, close the MCP `Server` (which closes its transport).
   * Runs between the immediate synchronous flush and the final `sqlite.close()`.
   */
  drain: () => Promise<void>;
}

/**
 * Builds a re-entrant-safe shutdown handler shared by both transport
 * branches (harden-http-server-lifecycle design.md "Shutdown ordering" /
 * "Stdio parity"). Ordering: (1) synchronous `flushIfDirty()` immediately —
 * cheap when clean, caps the loss window before the async drain can hang;
 * (2) the transport-specific drain (session/listener or MCP server close);
 * (3) stop the lifecycle-timer schedulers; (4) `sqlite.close()` (cancels the
 * deferred-flush timer, flushes if dirty, checkpoints WAL, closes); (5) exit
 * 0. A 10 s unref'd hard deadline runs in parallel: if the drain hasn't
 * finished by then, it logs `shutdown_timeout`, flushes synchronously one
 * last time, and exits non-zero so orchestrators can tell a forced shutdown
 * from a clean one.
 */
function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  let shuttingDown = false;

  return (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info({ event: 'shutdown_start', signal, transport: deps.transport });

    const deadline = setTimeout(() => {
      deps.logger.error({ event: 'shutdown_timeout', signal, transport: deps.transport });
      try {
        deps.sqlite.cancelDeferredFlush();
        deps.sqlite.flushIfDirty();
      } catch (err) {
        deps.logger.error({ event: 'shutdown_timeout_flush_failed', error: (err as Error).message });
      }
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();

    try {
      deps.sqlite.flushIfDirty();
    } catch (err) {
      deps.logger.error({ event: 'shutdown_flush_failed', error: (err as Error).message });
    }

    void (async () => {
      try {
        await deps.drain();
      } catch (err) {
        deps.logger.error({ event: 'shutdown_drain_failed', error: (err as Error).message });
      } finally {
        deps.cleanupScheduler.stop();
        deps.distillationScheduler.stop();
        try {
          deps.sqlite.close();
        } catch (err) {
          deps.logger.error({ event: 'shutdown_close_failed', error: (err as Error).message });
        }
        clearTimeout(deadline);
        deps.logger.info({ event: 'shutdown_complete', signal, transport: deps.transport });
        process.exit(0);
      }
    })();
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isStdio = args.includes('--stdio');
  const configPath = args.find(a => a.startsWith('--config='))?.split('=')[1];

  const config = loadConfig(configPath);
  ensureDataDir(config);

  // When using stdio transport, pino must write to stderr — stdout is reserved for MCP JSON-RPC
  const logger = createLogger(config, isStdio ? process.stderr : undefined);
  logger.info({ event: 'startup', data_dir: config.data_dir });

  // Initialize storage
  const sqlite = new SqliteStore(config.data_dir!);
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
  const qdrant = new QdrantStore(config, qdrantBreaker, logger);
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
  // Only instantiated when reranking is opted in (add-opt-in-rerank-stage):
  // stock installs never construct a `RerankProvider`, so `SearchService`
  // gets `undefined` and `recall` stays byte-for-byte unchanged. Enabling it
  // with a missing/invalid `search.rerank.model_env` value falls back to the
  // degraded provider (logged below) rather than crashing startup. Extracted
  // to `resolveRerankBootstrap` (task 5.6) so this wiring is unit-testable
  // without instantiating the rest of `main()`'s dependency graph.
  const { rerank, healthBreaker: rerankHealthBreaker } = resolveRerankBootstrap(config, {
    breaker: rerankBreaker,
    metrics,
    logger,
  });
  const storage = new StorageManager(sqlite, qdrant, embedding, metrics, config, summarization);

  // Bootstrap: hydrate SQLite from Qdrant if this is a new device
  try {
    const memoryCount = sqlite.countMemories();
    if (memoryCount === 0) {
      logger.info({ event: 'bootstrap', message: '[bootstrap] SQLite empty, checking Qdrant for existing memories' });
      const hydrated = await storage.bootstrapFromQdrant(logger);
      if (hydrated > 0) {
        logger.info({ event: 'bootstrap', message: `[bootstrap] hydrated ${hydrated} memories from Qdrant` });
      }
    }
  } catch (err) {
    logger.warn({ event: 'bootstrap_error', message: `[bootstrap] failed to hydrate from Qdrant: ${(err as Error).message}` });
  }

  // Embedding provenance: if the store already adopted an expected identity
  // and it differs from the active configuration, log it loudly at startup
  // (rather than only surfacing it lazily on the next health poll or write
  // attempt) — see embedding-provenance.
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
  const pipeline = new WritePipeline(config, storage, embedding, logger, extraction, metrics, summarization);
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
  const healthService = new HealthService(storage, embedding, config, healthBreakers, logger);

  // Scheduled cleanup: same execution path as `bhgbrain gc`, run on
  // `retention.cleanup_schedule` for the lifetime of this long-running
  // process (both stdio and HTTP transports keep the process alive).
  const retentionService = new RetentionService(config, storage, logger, metrics);
  const cleanupScheduler = new CleanupScheduler(config, retentionService, logger);
  cleanupScheduler.start();

  // Scheduled distillation: clusters related T2/T3 episodic memories and
  // consolidates each qualifying cluster into one T1 semantic memory. Off by
  // default (`retention.distillation.enabled: false`); the scheduler itself
  // is a no-op start() when disabled, mirroring `cleanupScheduler` above. See
  // add-memory-distillation.
  const distillationLlmClient = new DistillationLLMClient(config, distillationBreaker, metrics);
  const distillationService = new DistillationService(config, storage, pipeline, distillationLlmClient, logger, metrics);
  const distillationScheduler = new DistillationScheduler(config, distillationService, logger);
  distillationScheduler.start();

  const ctx: ToolContext = {
    config, storage, embedding, pipeline,
    search: searchService, backup: backupService,
    health: healthService, metrics, logger,
  };

  const resources = new ResourceHandler(config, storage, searchService, healthService);

  if (isStdio || !config.transport.http.enabled) {
    // MCP stdio transport
    const server = buildMcpServer(ctx, resources);
    // Task 5.2: stdio serves exactly one client through one long-lived
    // `Server`, so the notifier hook can point straight at it.
    // Fire-and-forget — a notification failure never fails the tool call
    // that triggered it, since the underlying mutation already succeeded.
    ctx.notifyResourceListChanged = () => {
      server.sendResourceListChanged().catch((err: unknown) => {
        logger.debug({ event: 'resource_list_changed_notify_failed', error: (err as Error).message });
      });
    };

    // Graceful teardown on both a signal and the client dropping the pipe
    // (MCP stdio clients typically end the child by closing stdin rather
    // than signaling) — see createShutdown's doc comment for ordering.
    const shutdown = createShutdown({
      logger,
      sqlite,
      cleanupScheduler,
      distillationScheduler,
      transport: 'stdio',
      drain: async () => {
        await server.close();
      },
    });
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    server.onclose = () => shutdown('transport-close');

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info({ event: 'connected', transport: 'stdio' });
  } else {
    // HTTP transport — also serves real MCP (Streamable HTTP) at /mcp
    // alongside the REST convenience endpoints.
    const { app, mcpSessions } = createHttpServer(config, ctx, resources, logger);
    const { host, port } = config.transport.http;

    const httpServer = app.listen(port, host, () => {
      logger.info({ event: 'listening', transport: 'http', host, port });
      console.log(`BHGBrain server listening on http://${host}:${port}`);
    });

    // Socket timeouts: Node's own defaults (5 s keep-alive, 300 s request,
    // 60 s headers) are wrong for this deployment shape — see
    // harden-http-server-lifecycle design.md "Timeout config keys".
    // `requestTimeout` bounds only receiving the request, so long-lived SSE
    // responses on `GET /mcp` are unaffected.
    applyHttpServerTimeouts(httpServer, config);

    // Clean teardown on shutdown: close every live MCP session's transport,
    // then the listener, then persist SQLite state before exiting — mirrors
    // the ordering the SDK expects (sessions closed while the process can
    // still flush their final I/O). See createShutdown's doc comment.
    const shutdown = createShutdown({
      logger,
      sqlite,
      cleanupScheduler,
      distillationScheduler,
      transport: 'http',
      drain: async () => {
        await mcpSessions.closeAll();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      },
    });
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
