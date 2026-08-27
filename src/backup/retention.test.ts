import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../storage/sqlite.js';
import { RetentionService } from './retention.js';
import { vi } from 'vitest';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';

describe('RetentionService', () => {
  let sqlite: SqliteStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-retention-test-'));
    sqlite = new SqliteStore(tempDir);
    await sqlite.init();
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function memory(id: string, lastAccessed: string, category: string | null = null) {
    return {
      id,
      namespace: 'global',
      collection: 'general',
      type: 'semantic' as const,
      category,
      content: `memory ${id}`,
      summary: `memory ${id}`,
      tags: [],
      source: 'cli' as const,
      checksum: id,
      importance: 0.2,
      access_count: 0,
      last_operation: 'ADD' as const,
      merged_from: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      last_accessed: lastAccessed,
    };
  }

  it('marks stale memories using typed sqlite APIs with unchanged behavior', () => {
    sqlite.insertMemory(memory('old-1', '2025-01-01T00:00:00.000Z'));
    sqlite.insertMemory(memory('new-1', '2026-12-31T00:00:00.000Z'));
    sqlite.insertMemory(memory('cat-1', '2025-01-01T00:00:00.000Z', 'policy'));
    sqlite.flushIfDirty();

    const config = { retention: { decay_after_days: 30 } } as unknown as BrainConfig;
    const storage = { sqlite } as unknown as StorageManager;
    const logger = { info: vi.fn() };
    const retention = new RetentionService(config, storage, logger);
    const staleMarked = retention.markStaleMemories();

    expect(staleMarked).toBe(1);
    const stale = sqlite.getStaleMemories(1, 10);
    expect(stale.map(s => s.id)).toContain('old-1');
    expect(stale.map(s => s.id)).not.toContain('cat-1');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'retention_stale_marked',
      stale_marked: 1,
    }));
  });

  it('batches GC persistence work and audits after batched delete', async () => {
    const expired = [{
      ...memory('old-2', '2025-01-01T00:00:00.000Z'),
      retention_tier: 'T2' as const,
      expires_at: '2025-02-01T00:00:00.000Z',
      decay_eligible: true,
      namespace: 'global',
      collection: 'general',
    }];

    const storage = {
      sqlite: {
        listExpiredMemories: vi.fn(() => expired),
        archiveMemory: vi.fn(),
        flushIfDirty: vi.fn(),
      },
      deleteMemories: vi.fn(async () => ({ deleted: 1, unreconciled: [], degraded: false })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const config = {
      retention: { archive_before_delete: true, pre_expiry_warning_days: 7 },
    } as unknown as BrainConfig;
    const logger = { info: vi.fn() };
    const retention = new RetentionService(config, storage, logger);

    const result = await retention.runGc();

    expect(result.deleted).toBe(1);
    expect(result.degraded).toBe(false);
    expect(result.unreconciled).toEqual([]);
    expect(storage.deleteMemories).toHaveBeenCalledTimes(1);
    expect(storage.logAudit).toHaveBeenCalledWith('FORGET', expired[0]!.id, 'global', 'system', { flush: false });
    expect(storage.sqlite.flushIfDirty).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'retention_gc',
      outcome: 'ok',
      scanned: 1,
      archived: 1,
      deleted: 1,
      degraded: false,
    }));
  });

  it('reports a degraded result and skips the FORGET audit when deleteMemories cannot reconcile all vectors', async () => {
    const expired = [
      {
        ...memory('old-3', '2025-01-01T00:00:00.000Z'),
        retention_tier: 'T2' as const,
        expires_at: '2025-02-01T00:00:00.000Z',
        decay_eligible: true,
        namespace: 'global',
        collection: 'general',
      },
      {
        ...memory('old-4', '2025-01-01T00:00:00.000Z'),
        retention_tier: 'T2' as const,
        expires_at: '2025-02-01T00:00:00.000Z',
        decay_eligible: true,
        namespace: 'global',
        collection: 'general',
      },
    ];

    const storage = {
      sqlite: {
        listExpiredMemories: vi.fn(() => expired),
        archiveMemory: vi.fn(),
        flushIfDirty: vi.fn(),
      },
      // Simulates a transient Qdrant error mid-batch: 'old-3' was confirmed
      // deleted, 'old-4' was not and remains unreconciled.
      deleteMemories: vi.fn(async () => ({ deleted: 1, unreconciled: ['old-4'], degraded: true })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const config = {
      retention: { archive_before_delete: true, pre_expiry_warning_days: 7 },
    } as unknown as BrainConfig;
    const logger = { info: vi.fn() };
    const retention = new RetentionService(config, storage, logger);

    const result = await retention.runGc();

    expect(result.deleted).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.unreconciled).toEqual(['old-4']);
    // Archive rows are still written for every expired candidate (unchanged
    // from before), but the FORGET audit — which asserts the memory is gone
    // — is only logged for the confirmed deletion.
    expect(storage.sqlite.archiveMemory).toHaveBeenCalledTimes(2);
    expect(storage.logAudit).toHaveBeenCalledTimes(1);
    expect(storage.logAudit).toHaveBeenCalledWith('FORGET', 'old-3', 'global', 'system', { flush: false });
    expect(storage.sqlite.flushIfDirty).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'retention_gc',
      outcome: 'degraded',
      deleted: 1,
      degraded: true,
      unreconciled: 1,
    }));
  });

  it('logs a structured summary for runConsolidation combining stale and low-importance counts', () => {
    sqlite.insertMemory(memory('old-5', '2025-01-01T00:00:00.000Z'));
    sqlite.flushIfDirty();

    const config = { retention: { decay_after_days: 30 } } as unknown as BrainConfig;
    const storage = { sqlite } as unknown as StorageManager;
    const logger = { info: vi.fn() };
    const retention = new RetentionService(config, storage, logger);

    const result = retention.runConsolidation();

    expect(result.staleMarked).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'retention_consolidation',
      outcome: 'ok',
      stale_marked: 1,
      low_importance_candidates: result.lowImportanceCandidates,
    }));
  });

  it('logs a dry-run outcome without mutating state', async () => {
    const expired = [{
      ...memory('old-6', '2025-01-01T00:00:00.000Z'),
      retention_tier: 'T2' as const,
      expires_at: '2025-02-01T00:00:00.000Z',
      decay_eligible: true,
      namespace: 'global',
      collection: 'general',
    }];
    const storage = {
      sqlite: {
        listExpiredMemories: vi.fn(() => expired),
      },
    } as unknown as StorageManager;
    const config = {
      retention: { archive_before_delete: true, pre_expiry_warning_days: 7 },
    } as unknown as BrainConfig;
    const logger = { info: vi.fn() };
    const retention = new RetentionService(config, storage, logger);

    const result = await retention.runGc({ dryRun: true });

    expect(result.scanned).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'retention_gc',
      outcome: 'dry_run',
      scanned: 1,
    }));
  });
});
