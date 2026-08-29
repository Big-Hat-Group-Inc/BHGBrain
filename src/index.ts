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
import { BackupService } from './backup/index.js';
import { RetentionService } from './backup/retention.js';
import { CleanupScheduler } from './backup/scheduler.js';
import { HealthService } from './health/index.js';
import { MetricsCollector } from './health/metrics.js';
import { createLogger } from './health/logger.js';
import { CircuitBreaker } from './resilience/index.js';
import { ResourceHandler } from './resources/index.js';
import type { ToolContext } from './tools/index.js';
import { createHttpServer } from './transport/http.js';
import { buildMcpServer } from './transport/mcp-server.js';

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
  const searchService = new SearchService(config, storage, embedding, metrics, logger, queryExpansion);
  const backupService = new BackupService(config, storage, logger);
  const healthService = new HealthService(storage, embedding, config, {
    [embeddingBreakerKey]: embeddingBreaker,
    qdrant: qdrantBreaker,
  }, logger);

  // Scheduled cleanup: same execution path as `bhgbrain gc`, run on
  // `retention.cleanup_schedule` for the lifetime of this long-running
  // process (both stdio and HTTP transports keep the process alive).
  const retentionService = new RetentionService(config, storage, logger, metrics);
  const cleanupScheduler = new CleanupScheduler(config, retentionService, logger);
  cleanupScheduler.start();

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

    // Clean teardown on shutdown: close every live MCP session's transport,
    // stop the scheduled-cleanup timer, then close the listener before
    // exiting — mirrors the ordering the SDK expects (sessions closed while
    // the process can still flush their final I/O).
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ event: 'shutdown_start', signal });
      void (async () => {
        await mcpSessions.closeAll();
        cleanupScheduler.stop();
        httpServer.close(() => {
          logger.info({ event: 'shutdown_complete', signal });
          process.exit(0);
        });
      })();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
