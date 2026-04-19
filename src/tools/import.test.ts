import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTool, type ToolContext } from './index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { WritePipeline } from '../pipeline/index.js';
import type { SearchService } from '../search/index.js';
import type { BackupService } from '../backup/index.js';
import type { HealthService } from '../health/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type pino from 'pino';
import { SECTION_MAPPINGS } from '../pipeline/parser.js';

describe('import tool', () => {
  let ctx: ToolContext;
  let pipelineProcess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pipelineProcess = vi.fn(async () => [{ id: 'mem-1', summary: 'test', type: 'semantic', operation: 'ADD', created_at: '2026-01-01' }]);

    ctx = {
      config: { device: { id: 'dev-1' } } as ToolContext['config'],
      storage: {
        sqlite: {
          countMemories: vi.fn(() => 10),
          flushIfDirty: vi.fn(),
        },
      } as unknown as StorageManager,
      embedding: { model: 'm', dimensions: 1 } as EmbeddingProvider,
      pipeline: { process: pipelineProcess } as unknown as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  it('imports a full 12-section profile and calls pipeline for each memory', async () => {
    const content = SECTION_MAPPINGS.map(
      m => `## ${m.section}. ${m.title}\n\nContent for section ${m.section}.`,
    ).join('\n\n');

    const result = await handleTool(ctx, 'import', { format: 'profile', content }) as Record<string, unknown>;

    expect(result.dry_run).toBe(false);
    expect(result.format).toBe('profile');
    expect(result.memories_created).toBe(10);
    expect(result.duplicates_skipped).toBe(0);
    expect(result.sections_processed).toBe(10);
    expect((result.collections as string[]).length).toBeGreaterThan(0);
    expect(pipelineProcess).toHaveBeenCalledTimes(10);

    // Verify first call used correct metadata
    const firstCall = pipelineProcess.mock.calls[0]![0];
    expect(firstCall.namespace).toBe('profile');
    expect(firstCall.collection).toBe('identity');
    expect(firstCall.source).toBe('import');
    expect(firstCall.retention_tier).toBe('T0');
  });

  it('detects duplicates when pipeline returns NOOP', async () => {
    // First call: ADD, second call: NOOP (duplicate)
    let callCount = 0;
    pipelineProcess.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        return [{ id: 'existing', summary: 'dup', type: 'semantic', operation: 'NOOP', created_at: '2026-01-01' }];
      }
      return [{ id: `mem-${callCount}`, summary: 'new', type: 'semantic', operation: 'ADD', created_at: '2026-01-01' }];
    });

    const content = `## 1. Identity & Role

Jane Doe, CTO.

## 2. Responsibilities

Owns architecture decisions.`;

    const result = await handleTool(ctx, 'import', { format: 'profile', content }) as Record<string, unknown>;

    expect(result.memories_created).toBe(1);
    expect(result.duplicates_skipped).toBe(1);
  });

  it('imports freeform document', async () => {
    const content = `## Architecture

We use microservices with TypeScript.

## Deployment

Deployed on AWS ECS.`;

    const result = await handleTool(ctx, 'import', { format: 'freeform', content }) as Record<string, unknown>;

    expect(result.format).toBe('freeform');
    expect(result.memories_created).toBeGreaterThan(0);
    expect(result.sections_processed).toBeUndefined();

    // Verify freeform defaults
    const firstCall = pipelineProcess.mock.calls[0]![0];
    expect(firstCall.collection).toBe('general');
    expect(firstCall.type).toBe('semantic');
    expect(firstCall.retention_tier).toBe('T2');
  });

  it('dry-run returns previews with zero writes', async () => {
    const content = `## 1. Identity & Role

Jane Doe, CTO at Acme Corp.`;

    const result = await handleTool(ctx, 'import', {
      format: 'profile',
      content,
      dry_run: true,
    }) as Record<string, unknown>;

    expect(result.dry_run).toBe(true);
    expect(result.memories_created).toBe(1);
    expect(result.duplicates_skipped).toBe(0);
    expect(result.collections).toEqual(['identity']);
    expect(Array.isArray(result.previews)).toBe(true);

    const previews = result.previews as Array<Record<string, unknown>>;
    expect(previews[0]!.collection).toBe('identity');
    expect(previews[0]!.type).toBe('semantic');
    expect(previews[0]!.retention_tier).toBe('T0');

    // Pipeline should NOT have been called
    expect(pipelineProcess).not.toHaveBeenCalled();
  });

  it('rejects empty content with INVALID_INPUT', async () => {
    const result = await handleTool(ctx, 'import', { format: 'profile', content: '' }) as Record<string, unknown>;

    expect(result.error).toBeDefined();
    expect((result.error as Record<string, unknown>).code).toBe('INVALID_INPUT');
  });

  it('uses custom namespace when provided', async () => {
    const content = `## 1. Identity & Role\n\nJane Doe.`;
    await handleTool(ctx, 'import', { format: 'profile', content, namespace: 'custom-ns' });

    const firstCall = pipelineProcess.mock.calls[0]![0];
    expect(firstCall.namespace).toBe('custom-ns');
  });
});
