import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tools/index.js';

const retentionMocks = {
  runGc: vi.fn(),
  getTierStats: vi.fn(),
  listExpiringSoon: vi.fn(),
  buildMetadataForTier: vi.fn(),
  listArchive: vi.fn(),
  searchArchive: vi.fn(),
  restoreArchive: vi.fn(),
};

vi.mock('../config/index.js', () => ({
  loadConfig: vi.fn(),
  ensureDataDir: vi.fn(),
}));

vi.mock('../storage/sqlite.js', () => ({
  SqliteStore: class {},
}));

vi.mock('../storage/qdrant.js', () => ({
  QdrantStore: class {},
}));

vi.mock('../storage/index.js', () => ({
  StorageManager: class {},
}));

vi.mock('../embedding/index.js', () => ({
  createEmbeddingProvider: vi.fn(),
}));

vi.mock('../pipeline/index.js', () => ({
  WritePipeline: class {},
}));

vi.mock('../search/index.js', () => ({
  SearchService: class {},
}));

vi.mock('../backup/index.js', () => ({
  BackupService: class {},
}));

vi.mock('../health/index.js', () => ({
  HealthService: class {},
}));

vi.mock('../backup/retention.js', () => ({
  RetentionService: class {
    runGc = retentionMocks.runGc;
    getTierStats = retentionMocks.getTierStats;
    listExpiringSoon = retentionMocks.listExpiringSoon;
    buildMetadataForTier = retentionMocks.buildMetadataForTier;
    listArchive = retentionMocks.listArchive;
    searchArchive = retentionMocks.searchArchive;
    restoreArchive = retentionMocks.restoreArchive;
  },
}));

vi.mock('../health/metrics.js', () => ({
  MetricsCollector: class {},
}));

vi.mock('../health/logger.js', () => ({
  createLogger: vi.fn(),
}));

vi.mock('../resilience/index.js', () => ({
  CircuitBreaker: class {},
}));

vi.mock('../tools/index.js', () => ({
  handleTool: vi.fn(async (_ctx, name) => ({ ok: true, tool: name })),
}));

describe('CLI', () => {
  beforeEach(() => {
    retentionMocks.runGc.mockReset().mockResolvedValue({ deleted: 2 });
    retentionMocks.getTierStats.mockReset().mockReturnValue({
      archived: 3,
      unsynced_vectors: 1,
      counts: { T0: 1, T1: 2, T2: 3, T3: 4 },
    });
    retentionMocks.listExpiringSoon.mockReset().mockReturnValue([{
      id: '12345678-1234-1234-1234-123456789abc',
      retention_tier: 'T2',
      expires_at: '2026-04-01T00:00:00.000Z',
      summary: 'Expiring soon',
    }]);
    retentionMocks.buildMetadataForTier.mockReset().mockReturnValue({
      expires_at: '2026-04-01T00:00:00.000Z',
      decay_eligible: true,
      review_due: '2026-03-25T00:00:00.000Z',
    });
    retentionMocks.listArchive.mockReset().mockReturnValue([{ id: 'arch-1' }]);
    retentionMocks.searchArchive.mockReset().mockReturnValue([{ id: 'arch-2' }]);
    retentionMocks.restoreArchive.mockReset().mockResolvedValue({ restored: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.exitCode = undefined;
  });

  function createMockContext(): ToolContext {
    return {
      config: {
        retention: { max_memories: 500000, tier_budgets: { T0: null, T1: 100000, T2: 200000, T3: 200000 } },
      } as never,
      storage: {
        sqlite: {
          listMemories: vi.fn(() => [{
            id: '12345678-1234-1234-1234-123456789abc',
            type: 'semantic',
            summary: 'Remember this',
            tags: ['tag1'],
            importance: 0.7,
            created_at: '2026-03-19T00:00:00.000Z',
            retention_tier: 'T1',
            expires_at: '2026-04-01T00:00:00.000Z',
            decay_eligible: false,
            review_due: '2026-03-25T00:00:00.000Z',
          }]),
          getMemoryById: vi.fn((id: string) => id === 'missing'
            ? null
            : {
                id,
                type: 'semantic',
                summary: 'Memory',
                tags: ['tag1'],
                importance: 0.7,
                created_at: '2026-03-19T00:00:00.000Z',
                retention_tier: 'T1',
                expires_at: '2026-04-01T00:00:00.000Z',
                decay_eligible: false,
                review_due: '2026-03-25T00:00:00.000Z',
              }),
          updateMemory: vi.fn(),
          flushIfDirty: vi.fn(),
          countMemories: vi.fn(() => 10),
          listCollections: vi.fn(() => [{ name: 'general', count: 1 }]),
          listCategories: vi.fn(() => [{ name: 'policy', slot: 'custom', revision: 2 }]),
          getDbSizeBytes: vi.fn(() => 2048),
          listAudit: vi.fn(() => [{
            timestamp: '2026-03-19T00:00:00.000Z',
            operation: 'remember',
            memory_id: '12345678',
            namespace: 'global',
            client_id: 'cli',
          }]),
          close: vi.fn(),
        },
      } as never,
      health: {
        check: vi.fn(async () => ({ status: 'healthy' })),
      } as never,
      embedding: {} as never,
      pipeline: {} as never,
      search: {} as never,
      backup: {} as never,
      metrics: {} as never,
      logger: {} as never,
    };
  }

  async function runProgram(args: string[], context?: ToolContext) {
    const { createProgram } = await import('./index.js');
    const createContext = vi.fn(async () => context ?? createMockContext());
    await createProgram(createContext as never).parseAsync(['node', 'bhgbrain', ...args]);
    return { createContext };
  }

  it('exits with code 1 and logs a fatal error when config loading fails', async () => {
    const { loadConfig } = await import('../config/index.js');
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('Invalid config: embedding.provider');
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { runCli } = await import('./index.js');
    await runCli(['node', 'bhgbrain', 'list']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith('Fatal error:', expect.any(Error));
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain('Invalid config: embedding.provider');
  });

  it('covers memory and tool-backed commands', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handleTool } = await import('../tools/index.js');
    vi.mocked(handleTool).mockImplementation(async (_ctx, name) => {
      if (name === 'search') {
        return { results: [{ id: '12345678-1234-1234-1234-123456789abc', score: 0.9, summary: 'Search result' }] };
      }
      return { ok: true, tool: name };
    });

    const context = createMockContext();
    await runProgram(['list'], context);
    await runProgram(['search', 'query'], context);
    await runProgram(['show', '12345678-1234-1234-1234-123456789abc'], context);
    await runProgram(['show', 'missing'], context);
    await runProgram(['forget', '12345678-1234-1234-1234-123456789abc'], context);
    await runProgram(['category', 'list'], context);
    await runProgram(['category', 'get', 'policy'], context);
    await runProgram(['category', 'set', 'policy', '--content', 'content'], context);
    await runProgram(['backup', 'create'], context);
    await runProgram(['backup', 'list'], context);
    await runProgram(['backup', 'restore', 'backup.zip'], context);

    expect(logSpy).toHaveBeenCalledWith('[12345678] (semantic) Remember this');
    expect(logSpy).toHaveBeenCalledWith('[12345678] score: 0.900  Search result');
    expect(errorSpy).toHaveBeenCalledWith('Memory missing not found.');
  });

  it('covers server and maintenance commands', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const execFileSync = vi.fn();
    const randomBytes = vi.fn(() => ({ toString: () => 'token-1234' }));
    vi.doMock('node:child_process', () => ({ execFileSync }));
    vi.doMock('node:crypto', () => ({ randomBytes }));

    const context = createMockContext();
    await runProgram(['server', 'start', '--stdio']);
    await runProgram(['server', 'status'], context);
    await runProgram(['server', 'token']);
    await runProgram(['gc', '--dry-run', '--tier', 'T2'], context);
    await runProgram(['stats', '--by-tier', '--expiring'], context);
    await runProgram(['health'], context);
    await runProgram(['audit'], context);

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['--stdio']),
      { stdio: 'inherit' },
    );
    expect(logSpy).toHaveBeenCalledWith('New token: token-1234');
    expect(logSpy).toHaveBeenCalledWith('Total memories: 10');
    expect(logSpy).toHaveBeenCalledWith('  T0: 1');
    expect(logSpy).toHaveBeenCalledWith('  12345678 T2 expires 2026-04-01T00:00:00.000Z Expiring soon');
    expect(logSpy).toHaveBeenCalledWith('[2026-03-19T00:00:00.000Z] remember 12345678 ns:global client:cli');
  });

  it('covers tier and archive commands including missing-memory branches', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const context = createMockContext();
    await runProgram(['tier', 'show', '12345678-1234-1234-1234-123456789abc'], context);
    await runProgram(['tier', 'show', 'missing'], context);
    await runProgram(['tier', 'set', '12345678-1234-1234-1234-123456789abc', 'T2'], context);
    await runProgram(['tier', 'set', 'missing', 'T2'], context);
    await runProgram(['tier', 'list', '--tier', 'T1'], context);
    await runProgram(['archive', 'list'], context);
    await runProgram(['archive', 'search', 'query'], context);
    await runProgram(['archive', 'restore', 'arch-1'], context);

    expect(errorSpy).toHaveBeenCalledWith('Memory missing not found.');
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true, id: '12345678-1234-1234-1234-123456789abc', tier: 'T2' }, null, 2));
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([{ id: 'arch-1' }], null, 2));
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ restored: true }, null, 2));
  });

  it('repair --from-qdrant calls bootstrapFromQdrant and prints summary', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = createMockContext();
    (context.storage as unknown as Record<string, unknown>).bootstrapFromQdrant = vi.fn(async () => 42);

    await runProgram(['repair', '--from-qdrant'], context);

    expect((context.storage as unknown as { bootstrapFromQdrant: ReturnType<typeof vi.fn> }).bootstrapFromQdrant).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[repair] hydrated 42 memories from Qdrant');
  });

  it('repair without flags shows error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const context = createMockContext();

    await runProgram(['repair'], context);

    expect(errorSpy).toHaveBeenCalledWith('Please specify a repair source. Available: --from-qdrant');
    expect(process.exitCode).toBe(1);
  });
});
