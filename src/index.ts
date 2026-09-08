#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadFileConfig, deriveRuntimeConfig, ensureDataDir } from './config/index.js';
import type { SqliteStore } from './storage/sqlite.js';
import type { CleanupScheduler, DistillationScheduler } from './backup/scheduler.js';
import type { BackupService } from './backup/index.js';
import { createLogger, toLogError } from './health/logger.js';
import { createHttpServer, applyHttpServerTimeouts, listenAsync } from './transport/http.js';
import { buildMcpServer } from './transport/mcp-server.js';
import { buildToolContext } from './context.js';
import type pino from 'pino';

/** Milliseconds a shutdown drain is given before the hard deadline forces exit. */
const SHUTDOWN_DEADLINE_MS = 10_000;

interface ShutdownDeps {
  logger: pino.Logger;
  sqlite: SqliteStore;
  cleanupScheduler: CleanupScheduler;
  distillationScheduler: DistillationScheduler;
  // Cancels BackupService's pending background-reconciliation retry timer
  // (align-runtime-entrypoint-contracts task 3.3) — stopped here, alongside
  // the two schedulers above, and always before sqlite.close() below, so a
  // pending retry can never fire against a closed store.
  backupService: BackupService;
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
 * (3) stop the lifecycle-timer schedulers and the backup retry timer; (4)
 * `sqlite.close()` (cancels the deferred-flush timer, flushes if dirty,
 * checkpoints WAL, closes); (5) exit. A 10 s unref'd hard deadline runs in
 * parallel: if the drain hasn't finished by then, it logs
 * `shutdown_timeout`, flushes synchronously one last time, and exits
 * non-zero so orchestrators can tell a forced shutdown from a clean one.
 *
 * The returned function's second parameter distinguishes a graceful signal
 * (SIGINT/SIGTERM/transport-close — exits 0) from a fatal condition (a
 * post-bind listener error, an unhandled rejection, an uncaught exception —
 * align-runtime-entrypoint-contracts task 3.2/3.3) which still runs the
 * exact same bounded drain/cleanup sequence but exits non-zero, so an
 * orchestrator can tell "shut down because it was asked to" from "shut down
 * because something broke".
 */
function createShutdown(deps: ShutdownDeps): (signal: string, opts?: { fatal?: boolean }) => void {
  let shuttingDown = false;

  return (signal: string, opts?: { fatal?: boolean }) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const exitCode = opts?.fatal ? 1 : 0;
    deps.logger.info({ event: 'shutdown_start', signal, transport: deps.transport, fatal: Boolean(opts?.fatal) });

    const deadline = setTimeout(() => {
      deps.logger.error({ event: 'shutdown_timeout', signal, transport: deps.transport });
      try {
        deps.sqlite.cancelDeferredFlush();
        deps.sqlite.flushIfDirty();
      } catch (err) {
        deps.logger.error({ event: 'shutdown_timeout_flush_failed', err: toLogError(err) });
      }
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();

    try {
      deps.sqlite.flushIfDirty();
    } catch (err) {
      deps.logger.error({ event: 'shutdown_flush_failed', err: toLogError(err) });
    }

    void (async () => {
      try {
        await deps.drain();
      } catch (err) {
        deps.logger.error({ event: 'shutdown_drain_failed', err: toLogError(err) });
      } finally {
        deps.cleanupScheduler.stop();
        deps.distillationScheduler.stop();
        deps.backupService.stop();
        try {
          deps.sqlite.close();
        } catch (err) {
          deps.logger.error({ event: 'shutdown_close_failed', err: toLogError(err) });
        }
        clearTimeout(deadline);
        deps.logger.info({ event: 'shutdown_complete', signal, transport: deps.transport, exit_code: exitCode });
        process.exit(exitCode);
      }
    })();
  };
}

/**
 * Registered before anything else in main() so an unhandled rejection or
 * uncaught exception during the earliest part of startup (before storage,
 * the logger, or the full shutdown machinery exist) still logs and exits
 * non-zero instead of Node's default opaque crash
 * (align-runtime-entrypoint-contracts task 3.3). Replaced by
 * `installFatalProcessHandlers` below once the real shutdown path is ready,
 * so a fatal event later in the process's life goes through the full
 * bounded drain instead of this bare `process.exit(1)`.
 */
function installBootstrapFatalHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    console.error('Fatal unhandledRejection during startup:', reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('Fatal uncaughtException during startup:', err);
    process.exit(1);
  });
}

/**
 * Upgrades process-level fatal-event handling from the early
 * `installBootstrapFatalHandlers` bare handlers to the full structured
 * shutdown path, once `shutdown` (and everything it depends on — sqlite,
 * the schedulers, the transport drain) actually exists
 * (align-runtime-entrypoint-contracts task 3.3). Replaces rather than adds
 * a second pair of listeners, so exactly one handler ever reacts to a given
 * fatal event.
 */
function installFatalProcessHandlers(logger: pino.Logger, shutdown: (signal: string, opts?: { fatal?: boolean }) => void): void {
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ event: 'unhandled_rejection', err });
    shutdown('unhandledRejection', { fatal: true });
  });
  process.on('uncaughtException', (err) => {
    logger.error({ event: 'uncaught_exception', err });
    shutdown('uncaughtException', { fatal: true });
  });
}

async function main() {
  installBootstrapFatalHandlers();

  const args = process.argv.slice(2);
  const isStdio = args.includes('--stdio');
  const configPath = args.find(a => a.startsWith('--config='))?.split('=')[1];

  // Read the raw file config first and persist device-id resolution back to
  // it (never to the environment-overlaid runtime config below) — a
  // temporary BHGBRAIN_* override must never end up written into
  // config.json as if it were a durable choice. See
  // align-runtime-entrypoint-contracts task 1.2.
  const fileConfig = loadFileConfig(configPath);
  ensureDataDir(fileConfig);
  const config = deriveRuntimeConfig(fileConfig, configPath);

  // When using stdio transport, pino must write to stderr — stdout is reserved for MCP JSON-RPC
  const logger = createLogger(config, isStdio ? process.stderr : undefined);
  logger.info({ event: 'startup', data_dir: config.data_dir });

  // Every provider, breaker, storage layer, and service the tool/resource
  // graph needs is assembled by the one composition root shared with the
  // CLI entrypoint (align-runtime-entrypoint-contracts task 2.1) — see
  // src/context.ts for what this builds and why it is not built inline
  // here anymore.
  const { ctx, resources, cleanupScheduler, distillationScheduler } = await buildToolContext(config, logger);
  const sqlite = ctx.storage.sqlite;
  const backupService = ctx.backup;

  if (isStdio || !config.transport.http.enabled) {
    // MCP stdio transport
    const server = buildMcpServer(ctx, resources);
    // Task 5.2: stdio serves exactly one client through one long-lived
    // `Server`, so the notifier hook can point straight at it.
    // Fire-and-forget — a notification failure never fails the tool call
    // that triggered it, since the underlying mutation already succeeded.
    ctx.notifyResourceListChanged = () => {
      server.sendResourceListChanged().catch((err: unknown) => {
        logger.debug({ event: 'resource_list_changed_notify_failed', err: toLogError(err) });
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
      backupService,
      transport: 'stdio',
      drain: async () => {
        await server.close();
      },
    });
    // Upgrades the bare startup-time handlers installed by
    // installBootstrapFatalHandlers() to the full bounded shutdown path,
    // now that it exists (task 3.3).
    installFatalProcessHandlers(logger, shutdown);
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    server.onclose = () => shutdown('transport-close');

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info({ event: 'connected', transport: 'stdio' });

    // Background schedulers start only once the transport that keeps this
    // process alive is actually connected (task 3.2) — mirrors the HTTP
    // branch below, which waits on a successful listener bind.
    cleanupScheduler.start();
    distillationScheduler.start();
  } else {
    // HTTP transport — also serves real MCP (Streamable HTTP) at /mcp
    // alongside the REST convenience endpoints.
    const { app, mcpSessions } = createHttpServer(config, ctx, resources, logger);
    const { host, port } = config.transport.http;

    // Awaited, not fire-and-forget: a bind failure (most commonly
    // EADDRINUSE) previously surfaced only as an unhandled 'error' event —
    // an opaque crash with no structured log and no chance to close
    // already-opened resources. Failing startup cleanly here, before any
    // scheduler or signal handler exists, means there is nothing further to
    // tear down beyond sqlite itself (align-runtime-entrypoint-contracts
    // task 3.2).
    let httpServer;
    try {
      httpServer = await listenAsync(app, port, host);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      logger.error({
        event: 'listen_failed', transport: 'http', host, port,
        err: nodeErr, code: nodeErr.code,
      });
      try {
        sqlite.close();
      } catch (closeErr) {
        logger.error({ event: 'listen_failed_close_failed', err: toLogError(closeErr) });
      }
      process.exit(1);
      return;
    }
    logger.info({ event: 'listening', transport: 'http', host, port });
    console.log(`BHGBrain server listening on http://${host}:${port}`);

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
      backupService,
      transport: 'http',
      drain: async () => {
        await mcpSessions.closeAll();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      },
    });
    // Upgrades the bare startup-time handlers to the full bounded shutdown
    // path now that it exists (task 3.3).
    installFatalProcessHandlers(logger, shutdown);
    // A listener error *after* a successful bind (e.g. a transient EMFILE
    // while accepting a connection) is rarer but still a real "listener
    // error" the spec requires structured, bounded handling for — routed
    // through the same fatal shutdown path (task 3.2).
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      logger.error({ event: 'http_listener_error', err, code: err.code });
      shutdown('http_listener_error', { fatal: true });
    });
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Background schedulers start only once the listener has actually bound
    // (task 3.2) — never speculatively before bind is confirmed.
    cleanupScheduler.start();
    distillationScheduler.start();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
