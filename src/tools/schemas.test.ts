import { describe, it, expect, vi } from 'vitest';
import { MCP_TOOL_DEFINITIONS, MCP_TOOL_NAMES } from './schemas.js';
import { handleTool, type ToolContext } from './index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { WritePipeline } from '../pipeline/index.js';
import type { SearchService } from '../search/index.js';
import type { BackupService } from '../backup/index.js';
import type { HealthService } from '../health/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type pino from 'pino';

function bareCtx(): ToolContext {
  return {
    config: {} as ToolContext['config'],
    storage: {} as StorageManager,
    embedding: {} as EmbeddingProvider,
    pipeline: {} as WritePipeline,
    search: {} as SearchService,
    backup: {} as BackupService,
    health: {} as HealthService,
    metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
  };
}

describe('MCP_TOOL_DEFINITIONS (task 2.1)', () => {
  it('has exactly 16 tools', () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(16);
  });

  it('every tool has a non-empty title and an annotations block', () => {
    for (const tool of MCP_TOOL_DEFINITIONS) {
      expect(tool.title, `${tool.name} is missing a title`).toBeTruthy();
      expect(tool.annotations, `${tool.name} is missing annotations`).toBeDefined();
      expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  it('recall and search are readOnlyHint and omit destructive/idempotent hints', () => {
    for (const name of ['recall', 'search']) {
      const tool = MCP_TOOL_DEFINITIONS.find(t => t.name === name)!;
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect('destructiveHint' in tool.annotations).toBe(false);
      expect('idempotentHint' in tool.annotations).toBe(false);
    }
  });

  it('forget, collections, category, backup, and revisions declare destructiveHint: true', () => {
    for (const name of ['forget', 'collections', 'category', 'backup', 'revisions']) {
      const tool = MCP_TOOL_DEFINITIONS.find(t => t.name === name)!;
      expect(tool.annotations.destructiveHint, `${name} should be destructiveHint: true`).toBe(true);
    }
  });

  it('recall, search, and remember declare an outputSchema; other tools do not', () => {
    for (const name of ['recall', 'search', 'remember']) {
      const tool = MCP_TOOL_DEFINITIONS.find(t => t.name === name)!;
      expect(tool.outputSchema, `${name} should declare outputSchema`).toBeDefined();
    }
    for (const tool of MCP_TOOL_DEFINITIONS) {
      if (['recall', 'search', 'remember'].includes(tool.name)) continue;
      expect((tool as { outputSchema?: unknown }).outputSchema).toBeUndefined();
    }
  });
});

describe('MCP_TOOL_NAMES lockstep with dispatch (task 3.2)', () => {
  it('every name in MCP_TOOL_NAMES has a dispatch case (does not return "Unknown tool")', async () => {
    for (const name of MCP_TOOL_NAMES) {
      const result = await handleTool(bareCtx(), name, {}, 'c1') as { error?: { message?: string } };
      // Any dispatch-reachable tool fails on input validation (bare {} args)
      // rather than falling through to the "Unknown tool" default arm.
      expect(result.error?.message, `${name} unexpectedly hit the "Unknown tool" arm`).not.toMatch(/^Unknown tool:/);
    }
  });

  it('an unknown name through dispatch surfaces "Unknown tool" (REST backstop, task 3.1 note)', async () => {
    const result = await handleTool(bareCtx(), 'does-not-exist', {}, 'c1') as { error: { code: string; message: string } };
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/^Unknown tool:/);
  });
});
