import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config/index.js';
import { createLogger } from './health/logger.js';
import { buildToolContext } from './context.js';

// align-runtime-entrypoint-contracts task 2.1: buildToolContext is the one
// composition root both src/index.ts's main() and src/cli/index.ts's
// createContext() now build the tool/resource dependency graph through.
// This exercises it directly (not through either entrypoint's own,
// entrypoint-specific tests) against a real, temporary SqliteStore.
describe('buildToolContext (align-runtime-entrypoint-contracts task 2.1)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function testConfig(tempDir: string) {
    // loadConfig(nonexistent path) resolves the same schema defaults
    // production startup does (see src/eval/harness.ts's identical
    // technique), pointed at an address that fails fast rather than this
    // machine's real config.json or a possibly-live localhost:6333 — the
    // bootstrap hydration attempt inside buildToolContext must degrade
    // gracefully (it is wrapped in try/catch) regardless of whether Qdrant
    // is reachable in the environment this test runs in.
    const config = loadConfig(join(tempDir, 'nonexistent-config.json'));
    config.data_dir = tempDir;
    config.qdrant.mode = 'external';
    config.qdrant.external_url = 'http://127.0.0.1:1';
    config.qdrant.operation_timeout_ms = 500;
    config.qdrant.health_timeout_ms = 200;
    return config;
  }

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bhgbrain-context-test-'));
    tempDirs.push(dir);
    return dir;
  }

  it('builds a fully-populated ToolContext with every dependency wired', async () => {
    const dir = tempDir();
    const config = testConfig(dir);
    const logger = createLogger(config);

    const { ctx, resources, cleanupScheduler, distillationScheduler } = await buildToolContext(config, logger);

    expect(ctx.config).toBe(config);
    expect(ctx.storage).toBeDefined();
    expect(ctx.storage.sqlite).toBeDefined();
    expect(ctx.embedding).toBeDefined();
    expect(ctx.pipeline).toBeDefined();
    expect(ctx.search).toBeDefined();
    expect(ctx.backup).toBeDefined();
    expect(ctx.health).toBeDefined();
    expect(ctx.metrics).toBeDefined();
    expect(ctx.logger).toBe(logger);
    expect(resources).toBeDefined();
    expect(cleanupScheduler).toBeDefined();
    expect(distillationScheduler).toBeDefined();

    ctx.storage.sqlite.close();
  });

  it('never starts the schedulers itself — the caller decides whether/when to arm them', async () => {
    const dir = tempDir();
    const config = testConfig(dir);
    const logger = createLogger(config);

    const { ctx, cleanupScheduler, distillationScheduler } = await buildToolContext(config, logger);

    // getState().armed is only ever set true by .start() (see
    // backup/scheduler.ts) — buildToolContext must never call it, so a
    // one-shot CLI invocation never arms an ongoing background timer.
    expect(cleanupScheduler.getState().armed).toBe(false);
    expect(distillationScheduler.getState().armed).toBe(false);

    ctx.storage.sqlite.close();
  });

  it('accepts a custom storage.sqlite_busy_timeout_ms without throwing (passed through to SqliteStore)', async () => {
    const dir = tempDir();
    const config = testConfig(dir);
    config.storage.sqlite_busy_timeout_ms = 12_345;
    const logger = createLogger(config);

    const { ctx } = await buildToolContext(config, logger);
    expect(ctx.storage.sqlite.healthCheck()).toBe(true);

    ctx.storage.sqlite.close();
  });

  it('two calls produce independent SqliteStore instances, not a shared singleton', async () => {
    const dirA = tempDir();
    const dirB = tempDir();
    const configA = testConfig(dirA);
    const configB = testConfig(dirB);
    const logger = createLogger(configA);

    const a = await buildToolContext(configA, logger);
    const b = await buildToolContext(configB, logger);

    expect(a.ctx.storage.sqlite).not.toBe(b.ctx.storage.sqlite);

    a.ctx.storage.sqlite.close();
    b.ctx.storage.sqlite.close();
  });

  it('schedulersManaged: false (the CLI shape) reports schedulers healthy despite never starting them', async () => {
    const dir = tempDir();
    const config = testConfig(dir);
    const logger = createLogger(config);

    const { ctx, cleanupScheduler, distillationScheduler } = await buildToolContext(config, logger, { schedulersManaged: false });
    // Never started — same as the default-true case — but health must not
    // report this as degraded for a process that never intends to start them.
    expect(cleanupScheduler.getState().armed).toBe(false);
    expect(distillationScheduler.getState().armed).toBe(false);

    const health = await ctx.health.check();
    expect(health.components.schedulers).toEqual({ status: 'healthy' });

    ctx.storage.sqlite.close();
  });

  it('schedulersManaged: true (the default/server shape) reports schedulers degraded before .start() is called', async () => {
    const dir = tempDir();
    const config = testConfig(dir);
    const logger = createLogger(config);

    const { ctx } = await buildToolContext(config, logger);

    const health = await ctx.health.check();
    expect(health.components.schedulers?.status).toBe('degraded');

    ctx.storage.sqlite.close();
  });

  it('degrades gracefully (does not throw) when Qdrant is unreachable during bootstrap hydration', async () => {
    const dir = tempDir();
    const config = testConfig(dir);
    const logger = createLogger(config);

    await expect(buildToolContext(config, logger)).resolves.toBeDefined();
  });
});
