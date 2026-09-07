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
  // Only the fields these tests actually assert on from a captured call —
  // WritePipeline.process's real `input` has many more (all optional except
  // content/namespace/collection/tags/source), so this stays a subset rather
  // than re-declaring the full shape.
  type CapturedProcessInput = {
    namespace: string;
    collection: string;
    source: string;
    type: string;
    content: string;
    retention_tier?: string;
    precomputedEmbedding?: number[];
  };
  let pipelineProcess: ReturnType<typeof vi.fn<
    (input: CapturedProcessInput) => Promise<Array<{ id: string; summary: string; type: string; operation: string; created_at: string }>>
  >>;

  beforeEach(() => {
    pipelineProcess = vi.fn(async () => [{ id: 'mem-1', summary: 'test', type: 'semantic', operation: 'ADD', created_at: '2026-01-01' }]);

    ctx = {
      config: {
        device: { id: 'dev-1' },
        import: { max_chunks: 500, max_chunk_chars: 8000, embedding_batch_size: 100 },
      } as ToolContext['config'],
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

  it('imports a full 10-section profile and calls pipeline for each memory', async () => {
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

  it('surfaces sections outside the 10 storage-mapped ones as sections_ignored', async () => {
    const content = `## 1. Identity & Role

Jane Doe, CTO.

## 11. Legacy Section

Content from an old 12-section template.`;

    const result = await handleTool(ctx, 'import', { format: 'profile', content }) as Record<string, unknown>;

    expect(result.sections_processed).toBe(1);
    expect(result.sections_ignored).toEqual([11]);
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

  // bound-corpus-scale-workflows task 3.1
  describe('import chunk-count and per-chunk size bounds', () => {
    it('rejects with INVALID_INPUT before any pipeline call when parsing would exceed max_chunks', async () => {
      (ctx.config as unknown as { import: { max_chunks: number } }).import.max_chunks = 3;
      // 5 short freeform paragraphs -> 5 chunks, over the max_chunks: 3 cap.
      const content = ['p1', 'p2', 'p3', 'p4', 'p5'].join('\n\n');

      const result = await handleTool(ctx, 'import', { format: 'freeform', content }) as Record<string, unknown>;

      expect((result.error as Record<string, unknown> | undefined)?.code).toBe('INVALID_INPUT');
      expect((result.error as { message: string }).message).toContain('5');
      expect((result.error as { message: string }).message).toContain('3');
      expect(pipelineProcess).not.toHaveBeenCalled();
    });

    it('applies the same max_chunks rejection to a dry run instead of only surfacing it on a real import', async () => {
      (ctx.config as unknown as { import: { max_chunks: number } }).import.max_chunks = 1;
      const content = ['p1', 'p2'].join('\n\n');

      const result = await handleTool(ctx, 'import', { format: 'freeform', content, dry_run: true }) as Record<string, unknown>;

      expect((result.error as Record<string, unknown> | undefined)?.code).toBe('INVALID_INPUT');
    });

    it('deterministically hard-splits an oversized chunk into max_chunk_chars-sized pieces instead of rejecting or embedding one oversized chunk', async () => {
      (ctx.config as unknown as { import: { max_chunk_chars: number; max_chunks: number } }).import.max_chunk_chars = 10;
      (ctx.config as unknown as { import: { max_chunk_chars: number; max_chunks: number } }).import.max_chunks = 100;
      const content = 'a'.repeat(25); // freeform single paragraph, 25 chars -> 3 pieces of <=10

      const result = await handleTool(ctx, 'import', { format: 'freeform', content }) as Record<string, unknown>;

      expect(result.memories_created).toBe(3);
      expect(pipelineProcess).toHaveBeenCalledTimes(3);
      const contents = pipelineProcess.mock.calls.map(c => c[0]!.content);
      expect(contents).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
    });
  });

  // bound-corpus-scale-workflows task 3.2
  describe('import batched embedding', () => {
    it('requests embeddings in batches sized by import.embedding_batch_size rather than one call per chunk', async () => {
      (ctx.config as unknown as { import: { embedding_batch_size: number } }).import.embedding_batch_size = 2;
      const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
      ctx.embedding = { model: 'm', dimensions: 2, embedBatch } as unknown as EmbeddingProvider;
      // 5 freeform paragraphs, batch size 2 -> ceil(5/2) = 3 embedBatch calls.
      const content = ['p1', 'p2', 'p3', 'p4', 'p5'].join('\n\n');

      await handleTool(ctx, 'import', { format: 'freeform', content });

      expect(embedBatch).toHaveBeenCalledTimes(3);
      expect(embedBatch.mock.calls[0]![0]).toHaveLength(2);
      expect(embedBatch.mock.calls[2]![0]).toHaveLength(1);
      expect(pipelineProcess).toHaveBeenCalledTimes(5);
      // Each pipeline call receives that chunk's precomputed vector.
      for (const call of pipelineProcess.mock.calls) {
        expect(call[0]!.precomputedEmbedding).toEqual([0.1, 0.2]);
      }
    });

    it('continues processing remaining chunks when one chunk fails entirely, reporting it instead of aborting the import', async () => {
      let callCount = 0;
      pipelineProcess.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('simulated total pipeline failure');
        }
        return [{ id: `mem-${callCount}`, summary: 'new', type: 'semantic', operation: 'ADD', created_at: '2026-01-01' }];
      });
      const content = ['p1', 'p2', 'p3'].join('\n\n');

      const result = await handleTool(ctx, 'import', { format: 'freeform', content }) as Record<string, unknown>;

      expect(pipelineProcess).toHaveBeenCalledTimes(3);
      expect(result.memories_created).toBe(2);
      expect(result.failed).toBe(1);
      expect((result.failures as Array<{ chunk_index: number; error: string }>)[0]).toMatchObject({
        chunk_index: 1, error: 'simulated total pipeline failure',
      });
    });

    it('falls back to per-item processing without failing the import when the whole embedding batch call rejects', async () => {
      ctx.embedding = {
        model: 'm', dimensions: 2,
        embedBatch: vi.fn(async () => { throw new Error('provider outage'); }),
      } as unknown as EmbeddingProvider;
      const content = `## 1. Identity & Role\n\nJane Doe.`;

      const result = await handleTool(ctx, 'import', { format: 'profile', content }) as Record<string, unknown>;

      expect(result.memories_created).toBe(1);
      expect(result.failed).toBeUndefined();
      expect((pipelineProcess.mock.calls[0]![0] as { precomputedEmbedding?: number[] }).precomputedEmbedding).toBeUndefined();
    });
  });
});

// add-auto-tagging (3.3): `handleImport` routes every memory through
// `ctx.pipeline.process()`, so a real `WritePipeline` (not the stubbed
// `pipelineProcess` above) must pick up auto-tagging with no separate
// wiring in `import.ts` itself.
describe('import tool auto-tagging (add-auto-tagging)', () => {
  it('routes imported freeform content through WritePipeline.extract(), gaining auto-derived tags', async () => {
    const { WritePipeline } = await import('../pipeline/index.js');

    const config = {
      deduplication: { similarity_threshold: 0.92 },
      pipeline: {
        extraction_enabled: false,
        fallback_to_threshold_dedup: true,
        contradiction_detection: { enabled: false, timeout_ms: 5000 },
        auto_tag_enabled: true,
        auto_tag_max_per_memory: 6,
        default_confidence: { cli: 1.0, api: 1.0, agent: 0.7, import: 0.5 },
      },
      device: { id: 'dev-1' },
      import: { max_chunks: 500, max_chunk_chars: 8000, embedding_batch_size: 100 },
    } as unknown as ToolContext['config'];

    const embedding = {
      model: 'test-model',
      dimensions: 2,
      embed: vi.fn(async () => [0.1, 0.2]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
      healthCheck: vi.fn(async () => true),
    } as unknown as EmbeddingProvider;

    const writeMemory = vi.fn();
    const storage = {
      sqlite: {
        getMemoryByChecksum: vi.fn(() => null),
        getMemoryById: vi.fn(() => null),
        insertMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        fullTextSearch: vi.fn(() => []),
        countMemories: vi.fn(() => 1),
      },
      qdrant: {
        searchSimilar: vi.fn(async () => []),
      },
      updateMemory: vi.fn(),
      writeMemory,
      writeMemoryWithoutVector: vi.fn(),
      deleteMemory: vi.fn(async () => true),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const realPipeline = new WritePipeline(config, storage, embedding);
    const importCtx: ToolContext = {
      config,
      storage,
      embedding,
      pipeline: realPipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };

    const content = 'See src/pipeline/index.ts for the extractionEnabled flag.';
    const result = await handleTool(importCtx, 'import', { format: 'freeform', content }) as Record<string, unknown>;

    expect(result.memories_created).toBe(1);
    expect(writeMemory).toHaveBeenCalledTimes(1);
    const [writtenMemory] = writeMemory.mock.calls[0]!;
    // The freeform parser's own caller-supplied tag is preserved...
    expect(writtenMemory.tags).toContain('imported');
    // ...and content-derived tags are unioned in for free.
    expect(writtenMemory.tags).toContain('src-pipeline-index-ts');
    expect(writtenMemory.tags).toContain('extractionenabled');
  });
});
