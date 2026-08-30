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

  // Minimal lifecycle-op sqlite mock shared by GC tests: beginLifecycleOperation
  // / endLifecycleOperation / setRetentionDegraded / listReviewCandidates are
  // all required by the failure-safe GC bracket even when a test isn't
  // exercising T1 review or degraded-health specifically.
  function lifecycleOpMocks() {
    return {
      beginLifecycleOperation: vi.fn(),
      endLifecycleOperation: vi.fn(),
      setRetentionDegraded: vi.fn(),
      listReviewCandidates: vi.fn(() => []),
    };
  }

  function qdrantStub(pointsCount = 0) {
    return {
      getCollectionInfo: vi.fn(async () => ({ points_count: pointsCount })),
      compact: vi.fn(async () => undefined),
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

  it('batches GC persistence work and audits archive + delete with structured details', async () => {
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
        ...lifecycleOpMocks(),
      },
      qdrant: qdrantStub(),
      deleteMemories: vi.fn(async () => ({ deleted: 1, unreconciled: [], degraded: false })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const config = {
      retention: {
        archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
        // null disables history pruning for these pre-existing GC tests, which
        // aren't exercising pruneAuditLog/pruneRevisions and don't mock them.
        audit_log_max_entries: null, revisions_per_memory_max: null,
      },
    } as unknown as BrainConfig;
    const logger = { info: vi.fn() };
    const retention = new RetentionService(config, storage, logger);

    const result = await retention.runGc();

    expect(result.deleted).toBe(1);
    expect(result.degraded).toBe(false);
    expect(result.unreconciled).toEqual([]);
    expect(storage.deleteMemories).toHaveBeenCalledTimes(1);
    expect(storage.sqlite.beginLifecycleOperation).toHaveBeenCalledWith('gc');
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledWith('gc');
    expect(storage.logAudit).toHaveBeenCalledWith('ARCHIVE', expired[0]!.id, 'global', 'system', expect.objectContaining({
      details: expect.objectContaining({ memory_id: expired[0]!.id, action: 'archive' }),
    }));
    expect(storage.logAudit).toHaveBeenCalledWith('FORGET', expired[0]!.id, 'global', 'system', expect.objectContaining({
      details: expect.objectContaining({ memory_id: expired[0]!.id, action: 'delete' }),
    }));
    expect(storage.sqlite.setRetentionDegraded).toHaveBeenCalledWith(false, null, expect.any(String));
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
        ...lifecycleOpMocks(),
      },
      qdrant: qdrantStub(),
      // Simulates a transient Qdrant error mid-batch: 'old-3' was confirmed
      // deleted, 'old-4' was not and remains unreconciled.
      deleteMemories: vi.fn(async () => ({ deleted: 1, unreconciled: ['old-4'], degraded: true })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const config = {
      retention: {
        archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
        // null disables history pruning for these pre-existing GC tests, which
        // aren't exercising pruneAuditLog/pruneRevisions and don't mock them.
        audit_log_max_entries: null, revisions_per_memory_max: null,
      },
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
    expect(storage.logAudit).toHaveBeenCalledWith('FORGET', 'old-3', 'global', 'system', expect.anything());
    expect(storage.logAudit).not.toHaveBeenCalledWith('FORGET', 'old-4', 'global', 'system', expect.anything());
    expect(storage.sqlite.setRetentionDegraded).toHaveBeenCalledWith(
      true,
      'Last cleanup (GC) run reported a partial failure',
      expect.any(String),
    );
    expect(storage.sqlite.flushIfDirty).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'retention_gc',
      outcome: 'degraded',
      deleted: 1,
      degraded: true,
      unreconciled: 1,
    }));
  });

  it('excludes T1 from direct delete and surfaces it as a review candidate instead', async () => {
    const t1Expired = {
      ...memory('t1-1', '2025-01-01T00:00:00.000Z'),
      retention_tier: 'T1' as const,
      expires_at: '2025-02-01T00:00:00.000Z',
      review_due: '2025-02-01T00:00:00.000Z',
      decay_eligible: true,
      namespace: 'global',
      collection: 'general',
    };
    const t2Expired = {
      ...memory('t2-1', '2025-01-01T00:00:00.000Z'),
      retention_tier: 'T2' as const,
      expires_at: '2025-02-01T00:00:00.000Z',
      decay_eligible: true,
      namespace: 'global',
      collection: 'general',
    };

    const storage = {
      sqlite: {
        // T1 rows come back from listExpiredMemories too (its expires_at has
        // passed), but only T2/T3 may be selected for direct archive/delete.
        listExpiredMemories: vi.fn(() => [t1Expired, t2Expired]),
        archiveMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        setRetentionDegraded: vi.fn(),
        listReviewCandidates: vi.fn(() => [t1Expired]),
      },
      qdrant: qdrantStub(),
      deleteMemories: vi.fn(async (memories: Array<{ id: string }>) => ({
        deleted: memories.length,
        unreconciled: [],
        degraded: false,
      })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const config = {
      retention: {
        archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
        // null disables history pruning for these pre-existing GC tests, which
        // aren't exercising pruneAuditLog/pruneRevisions and don't mock them.
        audit_log_max_entries: null, revisions_per_memory_max: null,
      },
    } as unknown as BrainConfig;
    const retention = new RetentionService(config, storage, { info: vi.fn() });

    const result = await retention.runGc();

    expect(result.scanned).toBe(1);
    expect(result.candidates.map(c => c.id)).toEqual(['t2-1']);
    expect(result.reviewCandidates.map(c => c.id)).toEqual(['t1-1']);
    expect(storage.deleteMemories).toHaveBeenCalledWith([t2Expired], { flush: false });
    expect(storage.logAudit).not.toHaveBeenCalledWith('FORGET', 't1-1', expect.anything(), expect.anything(), expect.anything());
  });

  it('reports T1 review candidates without mutating state, honoring a dry run', async () => {
    const t1Expired = {
      ...memory('t1-2', '2025-01-01T00:00:00.000Z'),
      retention_tier: 'T1' as const,
      expires_at: null,
      review_due: '2025-02-01T00:00:00.000Z',
      decay_eligible: true,
      namespace: 'global',
      collection: 'general',
    };
    const storage = {
      sqlite: {
        listExpiredMemories: vi.fn(() => []),
        listReviewCandidates: vi.fn(() => [t1Expired]),
      },
    } as unknown as StorageManager;
    const config = {
      retention: {
        archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
        // null disables history pruning for these pre-existing GC tests, which
        // aren't exercising pruneAuditLog/pruneRevisions and don't mock them.
        audit_log_max_entries: null, revisions_per_memory_max: null,
      },
    } as unknown as BrainConfig;
    const retention = new RetentionService(config, storage, { info: vi.fn() });

    const result = await retention.runGc({ dryRun: true });

    expect(result.scanned).toBe(0);
    expect(result.reviewCandidates.map(c => c.id)).toEqual(['t1-2']);
  });

  it('is failure-safe: an archive throw is caught, degraded is surfaced, and the lock is released', async () => {
    const expired = [{
      ...memory('bad-1', '2025-01-01T00:00:00.000Z'),
      retention_tier: 'T2' as const,
      expires_at: '2025-02-01T00:00:00.000Z',
      decay_eligible: true,
      namespace: 'global',
      collection: 'general',
    }];

    const storage = {
      sqlite: {
        listExpiredMemories: vi.fn(() => expired),
        archiveMemory: vi.fn(() => {
          throw new Error('disk full');
        }),
        flushIfDirty: vi.fn(),
        ...lifecycleOpMocks(),
      },
      qdrant: qdrantStub(),
      deleteMemories: vi.fn(async () => ({ deleted: 0, unreconciled: [], degraded: false })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const config = {
      retention: {
        archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
        // null disables history pruning for these pre-existing GC tests, which
        // aren't exercising pruneAuditLog/pruneRevisions and don't mock them.
        audit_log_max_entries: null, revisions_per_memory_max: null,
      },
    } as unknown as BrainConfig;
    const retention = new RetentionService(config, storage, { info: vi.fn() });

    const result = await retention.runGc();

    expect(result.degraded).toBe(true);
    expect(result.archived).toBe(0);
    // The failed memory is skipped for deletion rather than deleted without
    // a durable archive row.
    expect(storage.deleteMemories).toHaveBeenCalledWith([], { flush: false });
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledWith('gc');
    expect(storage.sqlite.setRetentionDegraded).toHaveBeenCalledWith(
      true,
      'Last cleanup (GC) run reported a partial failure',
      expect.any(String),
    );
  });

  it('compacts a collection once its deleted-vector ratio crosses the configured threshold', async () => {
    const expired = [
      {
        ...memory('c-1', '2025-01-01T00:00:00.000Z'),
        retention_tier: 'T3' as const,
        expires_at: '2025-02-01T00:00:00.000Z',
        decay_eligible: true,
        namespace: 'global',
        collection: 'general',
      },
      {
        ...memory('c-2', '2025-01-01T00:00:00.000Z'),
        retention_tier: 'T3' as const,
        expires_at: '2025-02-01T00:00:00.000Z',
        decay_eligible: true,
        namespace: 'global',
        collection: 'general',
      },
    ];
    // 2 deleted vs. 1 remaining point => ratio 2/3 ≈ 0.67, comfortably over
    // a 0.1 threshold.
    const qdrant = qdrantStub(1);
    const storage = {
      sqlite: {
        listExpiredMemories: vi.fn(() => expired),
        archiveMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        ...lifecycleOpMocks(),
      },
      qdrant,
      deleteMemories: vi.fn(async () => ({ deleted: 2, unreconciled: [], degraded: false })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const config = {
      retention: {
        archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
        // null disables history pruning for these pre-existing GC tests, which
        // aren't exercising pruneAuditLog/pruneRevisions and don't mock them.
        audit_log_max_entries: null, revisions_per_memory_max: null,
      },
    } as unknown as BrainConfig;
    const retention = new RetentionService(config, storage, { info: vi.fn() });

    const result = await retention.runGc();

    expect(result.compacted).toEqual(['global/general']);
    expect(qdrant.getCollectionInfo).toHaveBeenCalledWith('global', 'general');
    expect(qdrant.compact).toHaveBeenCalledWith('global', 'general', 0.1);
  });

  it('does not compact when the deleted-vector ratio stays under the threshold', async () => {
    const expired = [{
      ...memory('c-3', '2025-01-01T00:00:00.000Z'),
      retention_tier: 'T3' as const,
      expires_at: '2025-02-01T00:00:00.000Z',
      decay_eligible: true,
      namespace: 'global',
      collection: 'general',
    }];
    // 1 deleted vs. 999 remaining => ratio ~0.001, well under threshold.
    const qdrant = qdrantStub(999);
    const storage = {
      sqlite: {
        listExpiredMemories: vi.fn(() => expired),
        archiveMemory: vi.fn(),
        flushIfDirty: vi.fn(),
        ...lifecycleOpMocks(),
      },
      qdrant,
      deleteMemories: vi.fn(async () => ({ deleted: 1, unreconciled: [], degraded: false })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;

    const config = {
      retention: {
        archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
        // null disables history pruning for these pre-existing GC tests, which
        // aren't exercising pruneAuditLog/pruneRevisions and don't mock them.
        audit_log_max_entries: null, revisions_per_memory_max: null,
      },
    } as unknown as BrainConfig;
    const retention = new RetentionService(config, storage, { info: vi.fn() });

    const result = await retention.runGc();

    expect(result.compacted).toEqual([]);
    expect(qdrant.compact).not.toHaveBeenCalled();
  });

  it('records GC duration, deleted, and archived counts via the metrics collector', async () => {
    const expired = [{
      ...memory('m-1', '2025-01-01T00:00:00.000Z'),
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
        ...lifecycleOpMocks(),
      },
      qdrant: qdrantStub(),
      deleteMemories: vi.fn(async () => ({ deleted: 1, unreconciled: [], degraded: false })),
      logAudit: vi.fn(),
    } as unknown as StorageManager;
    const config = {
      retention: {
        archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
        // null disables history pruning for these pre-existing GC tests, which
        // aren't exercising pruneAuditLog/pruneRevisions and don't mock them.
        audit_log_max_entries: null, revisions_per_memory_max: null,
      },
    } as unknown as BrainConfig;
    const metrics = {
      recordHistogram: vi.fn(),
      incCounter: vi.fn(),
      setGauge: vi.fn(),
    };
    const retention = new RetentionService(config, storage, { info: vi.fn() }, metrics as never);

    await retention.runGc();

    expect(metrics.recordHistogram).toHaveBeenCalledWith('bhgbrain_gc_duration_ms', expect.any(Number));
    expect(metrics.incCounter).toHaveBeenCalledWith('bhgbrain_gc_deleted_total', 1);
    expect(metrics.incCounter).toHaveBeenCalledWith('bhgbrain_gc_archived_total', 1);
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
        listReviewCandidates: vi.fn(() => []),
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

  // -- trim-sqlite-query-and-health-overhead task 4.5: history-table pruning --

  describe('history-table pruning', () => {
    // `pruneAuditLog`/`pruneRevisions`/`listAudit`/`listRevisions` are bound to
    // the REAL sqlite store so pruning runs genuinely (real row survival, not a
    // stubbed count) — but `beginLifecycleOperation`/`setRetentionDegraded`/etc.
    // are the plain lifecycleOpMocks() no-ops the rest of this file uses for
    // runGc, since driving those for real against the same store instance
    // that's mid-'gc' lifecycle op is unrelated to what these tests verify
    // (assertMutableAllowed would reject the real store's own writes while its
    // own 'gc' lifecycle op is open — a separate, pre-existing behavior outside
    // this change's scope).
    function pruningStorage() {
      return {
        sqlite: {
          listExpiredMemories: vi.fn(() => []),
          pruneAuditLog: sqlite.pruneAuditLog.bind(sqlite),
          pruneRevisions: sqlite.pruneRevisions.bind(sqlite),
          listAudit: sqlite.listAudit.bind(sqlite),
          listRevisions: sqlite.listRevisions.bind(sqlite),
          flushIfDirty: vi.fn(),
          ...lifecycleOpMocks(),
        },
        qdrant: qdrantStub(),
        deleteMemories: vi.fn(async () => ({ deleted: 0, unreconciled: [], degraded: false })),
        logAudit: vi.fn(),
      } as unknown as StorageManager;
    }

    function seedAuditRows(count: number) {
      for (let i = 1; i <= count; i++) {
        sqlite.insertAudit({
          id: `audit-${i}`,
          timestamp: `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`,
          namespace: 'global',
          operation: 'ADD',
          memory_id: `mem-${i}`,
          client_id: 'test',
        });
      }
    }

    function seedRevisions(memoryId: string, count: number) {
      for (let r = 1; r <= count; r++) {
        sqlite.insertRevision(memoryId, r, `content v${r}`, '2026-01-01T00:00:00.000Z');
      }
    }

    it('prunes audit_log and memory_revisions to the configured caps and surfaces the counts', async () => {
      seedAuditRows(5);
      seedRevisions('mem-x', 5);

      const config = {
        retention: {
          archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
          audit_log_max_entries: 3, revisions_per_memory_max: 2,
        },
      } as unknown as BrainConfig;
      const logger = { info: vi.fn() };
      const retention = new RetentionService(config, pruningStorage(), logger);

      const result = await retention.runGc();

      expect(result.audit_pruned).toBe(2);
      expect(result.revisions_pruned).toBe(3);
      expect(sqlite.listAudit(10)).toHaveLength(3);
      expect(sqlite.listRevisions('mem-x')).toHaveLength(2);
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'retention_gc',
        audit_pruned: 2,
        revisions_pruned: 3,
      }));
    });

    it('a null cap disables the corresponding prune', async () => {
      seedAuditRows(5);
      seedRevisions('mem-y', 5);

      const config = {
        retention: {
          archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
          audit_log_max_entries: null, revisions_per_memory_max: null,
        },
      } as unknown as BrainConfig;
      const retention = new RetentionService(config, pruningStorage(), { info: vi.fn() });

      const result = await retention.runGc();

      expect(result.audit_pruned).toBe(0);
      expect(result.revisions_pruned).toBe(0);
      expect(sqlite.listAudit(10)).toHaveLength(5);
      expect(sqlite.listRevisions('mem-y')).toHaveLength(5);
    });

    it('dry-run prunes nothing even with caps configured', async () => {
      seedAuditRows(5);

      const config = {
        retention: {
          archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
          audit_log_max_entries: 1, revisions_per_memory_max: 1,
        },
      } as unknown as BrainConfig;
      const retention = new RetentionService(config, pruningStorage(), { info: vi.fn() });

      const result = await retention.runGc({ dryRun: true });

      expect(result.audit_pruned).toBe(0);
      expect(result.revisions_pruned).toBe(0);
      expect(sqlite.listAudit(10)).toHaveLength(5);
    });

    it('a pruned store round-trips through flush + reloadFromDisk', async () => {
      seedAuditRows(5);

      const config = {
        retention: {
          archive_before_delete: true, pre_expiry_warning_days: 7, compaction_deleted_threshold: 0.1,
          audit_log_max_entries: 2, revisions_per_memory_max: null,
        },
      } as unknown as BrainConfig;
      const retention = new RetentionService(config, pruningStorage(), { info: vi.fn() });

      await retention.runGc();
      expect(sqlite.listAudit(10)).toHaveLength(2);

      sqlite.flush();
      await sqlite.reloadFromDisk();

      expect(sqlite.listAudit(10)).toHaveLength(2);
    });
  });
});
