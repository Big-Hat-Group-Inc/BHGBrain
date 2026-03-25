#!/usr/bin/env node

import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDataDir } from '../config/index.js';
import { SqliteStore } from '../storage/sqlite.js';
import { QdrantStore } from '../storage/qdrant.js';
import { StorageManager } from '../storage/index.js';
import { createEmbeddingProvider } from '../embedding/index.js';
import { WritePipeline } from '../pipeline/index.js';
import { SearchService } from '../search/index.js';
import { BackupService } from '../backup/index.js';
import { HealthService } from '../health/index.js';
import { RetentionService } from '../backup/retention.js';
import { MetricsCollector } from '../health/metrics.js';
import { createLogger } from '../health/logger.js';
import { CircuitBreaker } from '../resilience/index.js';
import { handleTool, type ToolContext } from '../tools/index.js';

async function createContext(): Promise<ToolContext> {
  const config = loadConfig();
  ensureDataDir(config);
  const logger = createLogger(config);

  const sqlite = new SqliteStore(config.data_dir!);
  await sqlite.init();

  const breakerOptions = {
    failureThreshold: config.resilience.circuit_breaker.failure_threshold,
    openWindowMs: config.resilience.circuit_breaker.open_window_ms,
    halfOpenProbeCount: config.resilience.circuit_breaker.half_open_probe_count,
  };
  const embeddingBreaker = new CircuitBreaker(breakerOptions);
  const qdrantBreaker = new CircuitBreaker(breakerOptions);
  const metrics = new MetricsCollector(config);
  const qdrant = new QdrantStore(config, qdrantBreaker);
  const embedding = createEmbeddingProvider(config, { breaker: embeddingBreaker, metrics });
  const storage = new StorageManager(sqlite, qdrant, embedding);

  const pipeline = new WritePipeline(config, storage, embedding);
  const searchService = new SearchService(config, storage, embedding, metrics);
  const backupService = new BackupService(config, storage, logger);
  const healthService = new HealthService(storage, embedding, config, {
    openai_embedding: embeddingBreaker,
    qdrant: qdrantBreaker,
  });

  return { config, storage, embedding, pipeline, search: searchService, backup: backupService, health: healthService, metrics, logger };
}

export function createProgram(createContextImpl: typeof createContext = createContext): Command {
  const program = new Command()
    .name('bhgbrain')
    .description('BHGBrain companion CLI for managing persistent memory')
    .version('1.0.0');

  program
    .command('list')
    .description('List recent memories')
    .option('-l, --limit <n>', 'Max memories to show', '20')
    .option('-n, --namespace <ns>', 'Namespace', 'global')
    .action(async (opts) => {
      const ctx = await createContextImpl();
      const memories = ctx.storage.sqlite.listMemories(opts.namespace, parseInt(opts.limit));
      for (const m of memories) {
        console.log(`[${m.id.substring(0, 8)}] (${m.type}) ${m.summary}`);
        console.log(`  tags: ${m.tags.join(', ') || 'none'}  importance: ${m.importance}  created: ${m.created_at}`);
      }
      if (memories.length === 0) console.log('No memories found.');
      ctx.storage.sqlite.close();
    });

  program
    .command('search <query>')
    .description('Search memories')
    .option('-m, --mode <mode>', 'Search mode (semantic|fulltext|hybrid)', 'hybrid')
    .option('-l, --limit <n>', 'Max results', '10')
    .option('-n, --namespace <ns>', 'Namespace', 'global')
    .action(async (query, opts) => {
      const ctx = await createContextImpl();
      const result = await handleTool(ctx, 'search', { query, mode: opts.mode, limit: parseInt(opts.limit), namespace: opts.namespace });
      const data = result as { results: Array<{ id: string; score: number; summary: string }> };
      if (data.results) {
        for (const r of data.results) {
          console.log(`[${r.id.substring(0, 8)}] score: ${r.score.toFixed(3)}  ${r.summary}`);
        }
        if (data.results.length === 0) console.log('No results.');
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      ctx.storage.sqlite.close();
    });

  program
    .command('show <id>')
    .description('Show full memory details')
    .action(async (id) => {
      const ctx = await createContextImpl();
      const mem = ctx.storage.sqlite.getMemoryById(id);
      if (!mem) {
        console.error(`Memory ${id} not found.`);
      } else {
        console.log(JSON.stringify(mem, null, 2));
      }
      ctx.storage.sqlite.close();
    });

  program
    .command('forget <id>')
    .description('Delete a memory')
    .action(async (id) => {
      const ctx = await createContextImpl();
      const result = await handleTool(ctx, 'forget', { id });
      console.log(JSON.stringify(result, null, 2));
      ctx.storage.sqlite.close();
    });

  const categoryCmd = program.command('category').description('Manage persistent categories');

  categoryCmd
    .command('list')
    .description('List all categories')
    .action(async () => {
      const ctx = await createContextImpl();
      const result = await handleTool(ctx, 'category', { action: 'list' });
      console.log(JSON.stringify(result, null, 2));
      ctx.storage.sqlite.close();
    });

  categoryCmd
    .command('get <name>')
    .description('Get category content')
    .action(async (name) => {
      const ctx = await createContextImpl();
      const result = await handleTool(ctx, 'category', { action: 'get', name });
      console.log(JSON.stringify(result, null, 2));
      ctx.storage.sqlite.close();
    });

  categoryCmd
    .command('set <name>')
    .description('Set category content')
    .option('-s, --slot <slot>', 'Category slot', 'custom')
    .option('-c, --content <text>', 'Content text')
    .option('-f, --file <path>', 'Read content from file')
    .action(async (name, opts) => {
      const ctx = await createContextImpl();
      let content = opts.content;
      if (opts.file) {
        const { readFileSync } = await import('node:fs');
        content = readFileSync(opts.file, 'utf-8');
      }
      if (!content) {
        console.error('Provide --content or --file');
        process.exit(1);
        return;
      }
      const result = await handleTool(ctx, 'category', { action: 'set', name, slot: opts.slot, content });
      console.log(JSON.stringify(result, null, 2));
      ctx.storage.sqlite.close();
    });

  const backupCmd = program.command('backup').description('Manage backups');

  backupCmd
    .command('create')
    .description('Create a backup')
    .action(async () => {
      const ctx = await createContextImpl();
      const result = await handleTool(ctx, 'backup', { action: 'create' });
      console.log(JSON.stringify(result, null, 2));
      ctx.storage.sqlite.close();
    });

  backupCmd
    .command('list')
    .description('List backups')
    .action(async () => {
      const ctx = await createContextImpl();
      const result = await handleTool(ctx, 'backup', { action: 'list' });
      console.log(JSON.stringify(result, null, 2));
      ctx.storage.sqlite.close();
    });

  backupCmd
    .command('restore <path>')
    .description('Restore from backup')
    .action(async (path) => {
      const ctx = await createContextImpl();
      const result = await handleTool(ctx, 'backup', { action: 'restore', path });
      console.log(JSON.stringify(result, null, 2));
      ctx.storage.sqlite.close();
    });

  const serverCmd = program.command('server').description('Server management');

  serverCmd
    .command('start')
    .description('Start the BHGBrain server')
    .option('--stdio', 'Use stdio transport')
    .action(async (opts) => {
      const args = opts.stdio ? ['--stdio'] : [];
      const { execFileSync } = await import('node:child_process');
      execFileSync(process.execPath, [new URL('../index.js', import.meta.url).pathname, ...args], { stdio: 'inherit' });
    });

  serverCmd
    .command('status')
    .description('Check server health')
    .action(async () => {
      const ctx = await createContextImpl();
      const health = await ctx.health.check();
      console.log(JSON.stringify(health, null, 2));
      ctx.storage.sqlite.close();
    });

  serverCmd
    .command('token')
    .description('Rotate bearer token')
    .action(async () => {
      const { randomBytes } = await import('node:crypto');
      const token = randomBytes(32).toString('hex');
      console.log(`New token: ${token}`);
      console.log(`Set BHGBRAIN_TOKEN=${token} in your environment.`);
    });

  program
    .command('gc')
    .description('Run retention cleanup')
    .option('--dry-run', 'Report candidates without deleting')
    .option('--tier <tier>', 'Limit cleanup to a single tier (T1|T2|T3)')
    .action(async (opts) => {
      const ctx = await createContextImpl();
      const retention = new RetentionService(ctx.config, ctx.storage);
      const result = await retention.runGc({ dryRun: Boolean(opts.dryRun), tier: opts.tier });
      console.log(JSON.stringify(result, null, 2));
      ctx.storage.sqlite.close();
    });

  program
    .command('stats')
    .description('Show memory statistics')
    .option('--by-tier', 'Include tier breakdown')
    .option('--expiring', 'Show memories expiring soon')
    .action(async (opts) => {
      const ctx = await createContextImpl();
      const retention = new RetentionService(ctx.config, ctx.storage);
      const total = ctx.storage.sqlite.countMemories();
      const collections = ctx.storage.sqlite.listCollections();
      const categories = ctx.storage.sqlite.listCategories();
      const dbSize = ctx.storage.sqlite.getDbSizeBytes();

      console.log(`Total memories: ${total}`);
      console.log(`Collections: ${collections.length}`);
      for (const c of collections) {
        console.log(`  ${c.name}: ${c.count} memories`);
      }
      console.log(`Categories: ${categories.length}`);
      for (const c of categories) {
        console.log(`  ${c.name} (${c.slot}) rev ${c.revision}`);
      }
      console.log(`DB size: ${(dbSize / 1024).toFixed(1)} KB`);
      const tierStats = retention.getTierStats();
      console.log(`Archived memories: ${tierStats.archived}`);
      console.log(`Unsynced vectors: ${tierStats.unsynced_vectors}`);
      if (opts.byTier) {
        for (const [tier, count] of Object.entries(tierStats.counts)) {
          console.log(`  ${tier}: ${count}`);
        }
      }
      if (opts.expiring) {
        const expiring = retention.listExpiringSoon(20);
        for (const mem of expiring) {
          console.log(`  ${mem.id.substring(0, 8)} ${mem.retention_tier} expires ${mem.expires_at} ${mem.summary}`);
        }
      }
      ctx.storage.sqlite.close();
    });

  const tierCmd = program.command('tier').description('Inspect and manage retention tiers');

  tierCmd
    .command('show <id>')
    .description('Show retention details for a memory')
    .action(async (id) => {
      const ctx = await createContextImpl();
      const memory = ctx.storage.sqlite.getMemoryById(id);
      if (!memory) {
        console.error(`Memory ${id} not found.`);
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify({
          id: memory.id,
          retention_tier: memory.retention_tier,
          expires_at: memory.expires_at,
          decay_eligible: memory.decay_eligible,
          review_due: memory.review_due,
        }, null, 2));
      }
      ctx.storage.sqlite.close();
    });

  tierCmd
    .command('set <id> <tier>')
    .description('Set retention tier for a memory')
    .action(async (id, tier) => {
      const ctx = await createContextImpl();
      const memory = ctx.storage.sqlite.getMemoryById(id);
      if (!memory) {
        console.error(`Memory ${id} not found.`);
        process.exitCode = 1;
      } else {
        const retention = new RetentionService(ctx.config, ctx.storage);
        const metadata = retention.buildMetadataForTier(tier);
        ctx.storage.sqlite.updateMemory(id, {
          retention_tier: tier,
          expires_at: metadata.expires_at,
          decay_eligible: metadata.decay_eligible,
          review_due: metadata.review_due,
          updated_at: new Date().toISOString(),
        });
        ctx.storage.sqlite.flushIfDirty();
        console.log(JSON.stringify({ ok: true, id, tier }, null, 2));
      }
      ctx.storage.sqlite.close();
    });

  tierCmd
    .command('list')
    .description('List memories by retention tier')
    .requiredOption('--tier <tier>', 'Tier to list')
    .action(async (opts) => {
      const ctx = await createContextImpl();
      const memories = ctx.storage.sqlite.listMemories('global', 200).filter(mem => mem.retention_tier === opts.tier);
      console.log(JSON.stringify(memories.map(mem => ({
        id: mem.id,
        tier: mem.retention_tier,
        expires_at: mem.expires_at,
        summary: mem.summary,
      })), null, 2));
      ctx.storage.sqlite.close();
    });

  const archiveCmd = program.command('archive').description('Inspect and restore archived memories');

  archiveCmd
    .command('list')
    .description('List archived memory summaries')
    .action(async () => {
      const ctx = await createContextImpl();
      const retention = new RetentionService(ctx.config, ctx.storage);
      console.log(JSON.stringify(retention.listArchive(), null, 2));
      ctx.storage.sqlite.close();
    });

  archiveCmd
    .command('search <query>')
    .description('Search archived memory summaries')
    .action(async (query) => {
      const ctx = await createContextImpl();
      const retention = new RetentionService(ctx.config, ctx.storage);
      console.log(JSON.stringify(retention.searchArchive(query), null, 2));
      ctx.storage.sqlite.close();
    });

  archiveCmd
    .command('restore <id>')
    .description('Restore an archived summary into active memory')
    .action(async (id) => {
      const ctx = await createContextImpl();
      const retention = new RetentionService(ctx.config, ctx.storage);
      console.log(JSON.stringify(await retention.restoreArchive(id), null, 2));
      ctx.storage.sqlite.close();
    });

  program
    .command('repair')
    .description('Repair local state from external sources')
    .option('--from-qdrant', 'Hydrate local SQLite from Qdrant Cloud payloads')
    .action(async (opts) => {
      if (!opts.fromQdrant) {
        console.error('Please specify a repair source. Available: --from-qdrant');
        process.exitCode = 1;
        return;
      }
      const ctx = await createContextImpl();
      console.log('[repair] scanning Qdrant collections...');
      const hydrated = await ctx.storage.bootstrapFromQdrant();
      console.log(`[repair] hydrated ${hydrated} memories from Qdrant`);
      ctx.storage.sqlite.close();
    });

  program
    .command('health')
    .description('Check system health')
    .action(async () => {
      const ctx = await createContextImpl();
      const health = await ctx.health.check();
      console.log(JSON.stringify(health, null, 2));
      ctx.storage.sqlite.close();
    });

  program
    .command('audit')
    .description('Show audit log')
    .option('-l, --limit <n>', 'Max entries', '50')
    .action(async (opts) => {
      const ctx = await createContextImpl();
      const entries = ctx.storage.sqlite.listAudit(parseInt(opts.limit));
      for (const e of entries) {
        console.log(`[${e.timestamp}] ${e.operation} ${e.memory_id ?? ''} ns:${e.namespace} client:${e.client_id}`);
      }
      if (entries.length === 0) console.log('No audit entries.');
      ctx.storage.sqlite.close();
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runCli();
}
