import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../storage/sqlite.js';
import { RetentionService } from './retention.js';
import { vi } from 'vitest';

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

    const retention = new RetentionService({ retention: { decay_after_days: 30 } } as any, { sqlite } as any);
    const staleMarked = retention.markStaleMemories();

    expect(staleMarked).toBe(1);
    const stale = sqlite.getStaleMemories(1, 10);
    expect(stale.map(s => s.id)).toContain('old-1');
    expect(stale.map(s => s.id)).not.toContain('cat-1');
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
      deleteMemories: vi.fn(async () => 1),
      logAudit: vi.fn(),
    } as any;

    const retention = new RetentionService({
      retention: { archive_before_delete: true, pre_expiry_warning_days: 7 },
    } as any, storage);

    const result = await retention.runGc();

    expect(result.deleted).toBe(1);
    expect(storage.deleteMemories).toHaveBeenCalledTimes(1);
    expect(storage.logAudit).toHaveBeenCalledWith('FORGET', expired[0]!.id, 'global', 'system', { flush: false });
    expect(storage.sqlite.flushIfDirty).toHaveBeenCalledTimes(1);
  });
});
