import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../storage/sqlite.js';
import { DistillationService } from './distillation.js';
import { DistillationLLMError, type DistillationLLMClient } from './distillation-llm.js';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { WritePipeline } from './index.js';

function baseMemory(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    namespace: 'global',
    collection: 'general',
    type: 'episodic' as const,
    category: null,
    content: `content for ${id}`,
    summary: `summary ${id}`,
    tags: ['shared-tag'],
    source: 'agent' as const,
    checksum: id,
    importance: 0.5,
    retention_tier: 'T2' as const,
    expires_at: null,
    decay_eligible: true,
    review_due: null,
    access_count: 0,
    last_operation: 'ADD' as const,
    merged_from: null,
    archived: false,
    vector_synced: true,
    pinned: false,
    device_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_accessed: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}): BrainConfig {
  return {
    retention: {
      distillation: {
        enabled: true,
        schedule: '0 3 * * *',
        similarity_threshold: 0.85,
        min_cluster_size: 3,
        max_cluster_size: 20,
        max_clusters_per_run: 10,
        ...overrides,
      },
    },
  } as unknown as BrainConfig;
}

function points(ids: string[], vector = [1, 0]) {
  return ids.map(id => ({ id, payload: { type: 'episodic', retention_tier: 'T2' }, vector }));
}

describe('DistillationService', () => {
  let sqlite: SqliteStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-distill-test-'));
    sqlite = new SqliteStore(tempDir);
    await sqlite.init();
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('distills a qualifying cluster end-to-end: writes then archives sources', async () => {
    for (const id of ['a', 'b', 'c']) sqlite.insertMemory(baseMemory(id) as never);
    sqlite.flushIfDirty();

    const qdrant = { scrollCollection: vi.fn(async () => points(['a', 'b', 'c'])) };
    const storage = {
      sqlite,
      qdrant,
      deleteMemories: vi.fn(async (mems: Array<{ id: string }>) => ({ deleted: mems.length, unreconciled: [], degraded: false })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const llmClient = {
      distill: vi.fn(async () => ({ content: 'We deploy via GitHub Actions.', summary: 'Deploy via Actions' })),
    } as unknown as DistillationLLMClient;
    const pipeline = {
      process: vi.fn(async () => [{ id: 'new-1', summary: 'Deploy via Actions', type: 'semantic', operation: 'ADD', created_at: '2026-01-02T00:00:00.000Z' }]),
    } as unknown as WritePipeline;

    const service = new DistillationService(config(), storage, pipeline, llmClient, { info: vi.fn(), warn: vi.fn() });
    const result = await service.runOnce();

    expect(result.clustersFound).toBe(1);
    expect(result.distilled).toBe(1);
    expect(result.archived).toBe(3);
    expect(result.degraded).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(pipeline.process).toHaveBeenCalledWith(expect.objectContaining({
      source: 'distillation',
      type: 'semantic',
      retention_tier: 'T1',
      derived_from: ['a', 'b', 'c'],
    }));
    expect(storage.logAudit).toHaveBeenCalledWith('DISTILL', 'new-1', 'global', 'system', expect.objectContaining({
      details: expect.objectContaining({ action: 'distill', derived_from: ['a', 'b', 'c'] }),
    }));
    expect(sqlite.getArchiveByMemoryId('a')).not.toBeNull();
  });

  it('dry-run finds candidates without calling the LLM client or writing anything', async () => {
    for (const id of ['a', 'b', 'c']) sqlite.insertMemory(baseMemory(id) as never);
    sqlite.flushIfDirty();

    const qdrant = { scrollCollection: vi.fn(async () => points(['a', 'b', 'c'])) };
    const storage = { sqlite, qdrant, deleteMemories: vi.fn(), logAudit: vi.fn() } as unknown as StorageManager;
    const llmClient = { distill: vi.fn() } as unknown as DistillationLLMClient;
    const pipeline = { process: vi.fn() } as unknown as WritePipeline;

    const service = new DistillationService(config(), storage, pipeline, llmClient, { info: vi.fn(), warn: vi.fn() });
    const result = await service.runOnce({ dryRun: true });

    expect(result.candidates).toHaveLength(1);
    expect([...result.candidates[0]!.ids].sort()).toEqual(['a', 'b', 'c']);
    expect(llmClient.distill).not.toHaveBeenCalled();
    expect(pipeline.process).not.toHaveBeenCalled();
    expect(result.distilled).toBe(0);
    expect(sqlite.getArchiveByMemoryId('a')).toBeNull();
  });

  it('skips a cluster with reason no_key without failing the run', async () => {
    for (const id of ['a', 'b', 'c']) sqlite.insertMemory(baseMemory(id) as never);
    sqlite.flushIfDirty();

    const qdrant = { scrollCollection: vi.fn(async () => points(['a', 'b', 'c'])) };
    const storage = { sqlite, qdrant, deleteMemories: vi.fn(), logAudit: vi.fn() } as unknown as StorageManager;
    const llmClient = {
      distill: vi.fn(async () => { throw new DistillationLLMError('missing key', 'no_key'); }),
    } as unknown as DistillationLLMClient;
    const pipeline = { process: vi.fn() } as unknown as WritePipeline;

    const service = new DistillationService(config(), storage, pipeline, llmClient, { info: vi.fn(), warn: vi.fn() });
    const result = await service.runOnce();

    expect(result.distilled).toBe(0);
    expect(result.skipped).toEqual([{ reason: 'no_key', count: 1 }]);
    expect(pipeline.process).not.toHaveBeenCalled();
  });

  it('skips a cluster with reason llm_error on an unexpected LLM failure', async () => {
    for (const id of ['a', 'b', 'c']) sqlite.insertMemory(baseMemory(id) as never);
    sqlite.flushIfDirty();

    const qdrant = { scrollCollection: vi.fn(async () => points(['a', 'b', 'c'])) };
    const storage = { sqlite, qdrant, deleteMemories: vi.fn(), logAudit: vi.fn() } as unknown as StorageManager;
    const llmClient = {
      distill: vi.fn(async () => { throw new DistillationLLMError('API 500', 'llm_error'); }),
    } as unknown as DistillationLLMClient;
    const pipeline = { process: vi.fn() } as unknown as WritePipeline;

    const service = new DistillationService(config(), storage, pipeline, llmClient, { info: vi.fn(), warn: vi.fn() });
    const result = await service.runOnce();

    expect(result.skipped).toEqual([{ reason: 'llm_error', count: 1 }]);
  });

  it('marks the run degraded and leaves sources active when archival/deletion fails after a successful write', async () => {
    for (const id of ['a', 'b', 'c']) sqlite.insertMemory(baseMemory(id) as never);
    sqlite.flushIfDirty();

    const qdrant = { scrollCollection: vi.fn(async () => points(['a', 'b', 'c'])) };
    const storage = {
      sqlite,
      qdrant,
      deleteMemories: vi.fn(async () => { throw new Error('qdrant down'); }),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
    const llmClient = { distill: vi.fn(async () => ({ content: 'x', summary: 'y' })) } as unknown as DistillationLLMClient;
    const pipeline = {
      process: vi.fn(async () => [{ id: 'new-1', summary: 'y', type: 'semantic', operation: 'ADD', created_at: '2026-01-02T00:00:00.000Z' }]),
    } as unknown as WritePipeline;

    const service = new DistillationService(config(), storage, pipeline, llmClient, { info: vi.fn(), warn: vi.fn() });
    const result = await service.runOnce();

    expect(result.distilled).toBe(1);
    expect(result.degraded).toBe(true);
    // Archive rows were written (archival itself succeeded)...
    expect(sqlite.getArchiveByMemoryId('a')).not.toBeNull();
    // ...but the source memory row is still present since delete failed.
    expect(sqlite.getMemoryById('a')).not.toBeNull();
  });

  it('does not call the LLM client for a cluster below min_cluster_size', async () => {
    for (const id of ['a', 'b']) sqlite.insertMemory(baseMemory(id) as never);
    sqlite.flushIfDirty();

    const qdrant = { scrollCollection: vi.fn(async () => points(['a', 'b'])) };
    const storage = { sqlite, qdrant, deleteMemories: vi.fn(), logAudit: vi.fn() } as unknown as StorageManager;
    const llmClient = { distill: vi.fn() } as unknown as DistillationLLMClient;
    const pipeline = { process: vi.fn() } as unknown as WritePipeline;

    const service = new DistillationService(config(), storage, pipeline, llmClient, { info: vi.fn(), warn: vi.fn() });
    const result = await service.runOnce();

    expect(result.clustersFound).toBe(0);
    expect(llmClient.distill).not.toHaveBeenCalled();
  });
});
