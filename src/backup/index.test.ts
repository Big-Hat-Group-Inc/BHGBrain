import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { BackupService } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type pino from 'pino';
import type { StorageManager } from '../storage/index.js';
import { embeddingUnavailable } from '../errors/index.js';

function makeBackupFile(
  dir: string,
  payload: Buffer,
  headerOverrides?: Partial<{ version: number; memory_count: number; embedding_model: string; embedding_dimensions: number }>,
): string {
  const checksum = createHash('sha256').update(payload).digest('hex');
  const header = Buffer.from(JSON.stringify({
    version: 1,
    memory_count: 2,
    checksum,
    embedding_model: 'test-model',
    embedding_dimensions: 3,
    ...headerOverrides,
  }), 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  const data = Buffer.concat([len, header, payload]);
  const path = join(dir, 'sample.bhgb');
  writeFileSync(path, data);
  return path;
}

function createConfig(tempDir: string): BrainConfig {
  return {
    data_dir: tempDir,
    embedding: { model: 'test-model', dimensions: 3 },
  } as unknown as BrainConfig;
}

// Flushes pending microtasks so fire-and-forget background reconciliation
// (started but not awaited by restore()) gets a chance to run.
async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('BackupService restore activation', () => {
  it('creates a v2 backup as a restrictive committed artifact without staging leftovers', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    mkdirSync(join(tempDir, 'backups'));
    const storage = {
      sqlite: {
        exportData: vi.fn(() => Buffer.from('sqlite-image')),
        countMemories: vi.fn(() => 3),
        insertBackupMeta: vi.fn(),
        flushIfDirty: vi.fn(),
      },
    } as unknown as StorageManager;

    const result = await new BackupService(createConfig(tempDir), storage).create();
    const image = readFileSync(result.path);
    const headerLength = image.readUInt32LE(0);
    const header = JSON.parse(image.subarray(4, 4 + headerLength).toString('utf8')) as Record<string, unknown>;

    expect(header).toEqual(expect.objectContaining({
      version: 2, memory_count: 3, checksum: expect.any(String), header_checksum: expect.any(String),
    }));
    expect(statSync(result.path).mode & 0o077).toBe(0);
    expect(readdirSync(join(tempDir, 'backups')).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(storage.sqlite.insertBackupMeta).toHaveBeenCalledWith(
      result.path, image.length, 3, expect.any(String),
    );

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects a v2 header metadata mutation before activation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('body');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const header = Buffer.from(JSON.stringify({
      version: 2, memory_count: 1, checksum, created_at: '2026-01-01T00:00:00.000Z',
      embedding_model: 'test-model', embedding_dimensions: 3, header_checksum: 'tampered',
    }));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    const backupPath = join(tempDir, 'tampered-v2.bhgb');
    writeFileSync(backupPath, Buffer.concat([length, header, payload]));
    const storage = {
      sqlite: { beginLifecycleOperation: vi.fn(), endLifecycleOperation: vi.fn() },
      activateSqliteImage: vi.fn(),
    } as unknown as StorageManager;

    await expect(new BackupService(createConfig(tempDir), storage).restore(backupPath))
      .rejects.toThrow('header metadata checksum mismatch');
    expect(storage.activateSqliteImage).not.toHaveBeenCalled();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects an unsupported backup version before activation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const backupPath = makeBackupFile(tempDir, Buffer.from('not-used'), { version: 99 });
    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(), endLifecycleOperation: vi.fn(),
        countMemories: vi.fn(), countUnsyncedVectors: vi.fn(),
      },
      activateSqliteImage: vi.fn(),
    } as unknown as StorageManager;

    await expect(new BackupService(createConfig(tempDir), storage).restore(backupPath))
      .rejects.toThrow('Unsupported backup format version: 99');
    expect(storage.activateSqliteImage).not.toHaveBeenCalled();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reloads sqlite and reports reconciled when there is no vector drift', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-1');
    const backupPath = makeBackupFile(tempDir, payload, { memory_count: 7 });

    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 7),
        countUnsyncedVectors: vi.fn(() => 0),
      },
      activateSqliteImage: vi.fn(async () => {}),
      detectAndMarkVectorDrift: vi.fn(async () => ({ mode: 'no-drift', driftedCount: 0 })),
      reconcileVectorsFromSqlite: vi.fn(async () => ({ reconciled: 0, remaining: 0, boundReached: false })),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = createConfig(tempDir);
    const service = new BackupService(config, storage, logger);

    const result = await service.restore(backupPath);
    expect(result).toEqual({
      memory_count: 7,
      metadata_activated: true,
      vector_reconciliation: {
        status: 'healthy',
        state: 'reconciled',
        unsynced_vectors: 0,
      },
    });
    expect(storage.sqlite.beginLifecycleOperation).toHaveBeenCalledWith('restore');
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledWith(undefined, 'restore');
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledTimes(1);
    expect(storage.activateSqliteImage).toHaveBeenCalledTimes(1);
    expect(storage.detectAndMarkVectorDrift).toHaveBeenCalledWith({
      expectedEmbeddingModel: 'test-model',
      expectedEmbeddingDimensions: 3,
      lifecycleToken: undefined,
    });
    expect(storage.reconcileVectorsFromSqlite).not.toHaveBeenCalled();
    expect(storage.setBackgroundReconciliationActive).not.toHaveBeenCalled();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('releases the restore lock before background reconciliation runs and reports reconciling', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-drift');
    const backupPath = makeBackupFile(tempDir, payload, { memory_count: 5 });

    const callOrder: string[] = [];
    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(() => { callOrder.push('endLifecycleOperation'); }),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 5),
        countUnsyncedVectors: vi.fn(() => 0),
      },
      activateSqliteImage: vi.fn(async () => {}),
      detectAndMarkVectorDrift: vi.fn(async () => ({ mode: 'partial-drift', driftedCount: 2 })),
      reconcileVectorsFromSqlite: vi.fn(async () => {
        callOrder.push('reconcileVectorsFromSqlite');
        return { reconciled: 2, remaining: 0, boundReached: false };
      }),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = createConfig(tempDir);
    const service = new BackupService(config, storage, logger);

    const result = await service.restore(backupPath);

    expect(result).toEqual({
      memory_count: 5,
      metadata_activated: true,
      vector_reconciliation: {
        status: 'degraded',
        state: 'reconciling',
        unsynced_vectors: 2,
        message: 'Restore activated SQLite metadata; vector reconciliation for the drifted subset is continuing in the background.',
      },
    });
    // The lock is released before background reconciliation is kicked off,
    // not held for the full re-embed.
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledTimes(1);
    expect(storage.setBackgroundReconciliationActive).toHaveBeenCalledWith(true);
    expect(storage.reconcileVectorsFromSqlite).toHaveBeenCalledWith(expect.objectContaining({
      batchSize: 100,
    }));
    expect(callOrder[0]).toBe('endLifecycleOperation');

    await flushMicrotasks();
    expect(storage.setBackgroundReconciliationActive).toHaveBeenLastCalledWith(false);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back to a full rebuild and clears managed vectors when the embedding model changed', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-model-change');
    const backupPath = makeBackupFile(tempDir, payload, {
      embedding_model: 'old-model', embedding_dimensions: 1536, memory_count: 3,
    });

    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 3),
        countUnsyncedVectors: vi.fn(() => 3),
      },
      activateSqliteImage: vi.fn(async () => {}),
      detectAndMarkVectorDrift: vi.fn(async () => ({ mode: 'full-rebuild', driftedCount: 3 })),
      reconcileVectorsFromSqlite: vi.fn(async () => ({ reconciled: 3, remaining: 0, boundReached: false })),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = createConfig(tempDir);
    const service = new BackupService(config, storage, logger);

    const result = await service.restore(backupPath);

    expect(storage.detectAndMarkVectorDrift).toHaveBeenCalledWith({
      expectedEmbeddingModel: 'old-model',
      expectedEmbeddingDimensions: 1536,
      lifecycleToken: undefined,
    });
    expect(result.vector_reconciliation).toEqual({
      status: 'degraded',
      state: 'reconciling',
      unsynced_vectors: 3,
      message: 'Restore activated SQLite metadata; the embedding model or dimensions changed since this backup, so vectors are being fully rebuilt in the background.',
    });

    await flushMicrotasks();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('retries bounded reconciliation with backoff when a batch remains unsynced, then gives up after the retry cap', async () => {
    vi.useFakeTimers();
    try {
      const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
      const payload = Buffer.from('db-bytes-retry');
      const backupPath = makeBackupFile(tempDir, payload, { memory_count: 4 });

      const storage = {
        sqlite: {
          beginLifecycleOperation: vi.fn(),
          endLifecycleOperation: vi.fn(),
          getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
          countMemories: vi.fn(() => 4),
          countUnsyncedVectors: vi.fn(() => 4),
        },
        activateSqliteImage: vi.fn(async () => {}),
        detectAndMarkVectorDrift: vi.fn(async () => ({ mode: 'partial-drift', driftedCount: 4 })),
        // Always reports remaining work, so every attempt should retry.
        reconcileVectorsFromSqlite: vi.fn(async () => ({ reconciled: 0, remaining: 4, boundReached: true })),
        setBackgroundReconciliationActive: vi.fn(),
      } as unknown as StorageManager;

      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
      const config = createConfig(tempDir);
      const service = new BackupService(config, storage, logger);

      await service.restore(backupPath);
      await vi.advanceTimersByTimeAsync(0);
      expect(storage.reconcileVectorsFromSqlite).toHaveBeenCalledTimes(1);

      // BACKGROUND_RECONCILE_MAX_RETRIES is 3: the initial attempt plus two
      // retries reach the cap, after which it gives up and reports inactive.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(storage.reconcileVectorsFromSqlite).toHaveBeenCalledTimes(3);
      expect(storage.setBackgroundReconciliationActive).toHaveBeenLastCalledWith(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'backup_restore_background_reconcile_retries_exhausted',
      }));

      rmSync(tempDir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports pending vector reconciliation when drift detection fails after activation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-pending');
    const backupPath = makeBackupFile(tempDir, payload, { memory_count: 4 });

    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 4),
        countUnsyncedVectors: vi.fn(() => 4),
      },
      activateSqliteImage: vi.fn(async () => {}),
      detectAndMarkVectorDrift: vi.fn(async () => {
        throw embeddingUnavailable('Embedding provider is unavailable: missing API credentials');
      }),
      reconcileVectorsFromSqlite: vi.fn(),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = createConfig(tempDir);
    const service = new BackupService(config, storage, logger);

    const result = await service.restore(backupPath);

    expect(result).toEqual({
      memory_count: 4,
      metadata_activated: true,
      vector_reconciliation: {
        status: 'degraded',
        state: 'pending',
        unsynced_vectors: 4,
        message: 'Embedding provider is unavailable: missing API credentials',
      },
    });
    expect(logger.warn).toHaveBeenCalled();
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledTimes(1);
    expect(storage.reconcileVectorsFromSqlite).not.toHaveBeenCalled();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports reconciled with no reconciliation work when the restored backup has zero memories', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-empty');
    const backupPath = makeBackupFile(tempDir, payload, { memory_count: 0 });

    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 0),
        countUnsyncedVectors: vi.fn(() => 0),
      },
      activateSqliteImage: vi.fn(async () => {}),
      detectAndMarkVectorDrift: vi.fn(),
      reconcileVectorsFromSqlite: vi.fn(),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = createConfig(tempDir);
    const service = new BackupService(config, storage, logger);

    const result = await service.restore(backupPath);

    expect(result).toEqual({
      memory_count: 0,
      metadata_activated: true,
      vector_reconciliation: {
        status: 'healthy',
        state: 'reconciled',
        unsynced_vectors: 0,
      },
    });
    expect(storage.detectAndMarkVectorDrift).not.toHaveBeenCalled();
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledTimes(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails restore when activation fails', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-2');
    const backupPath = makeBackupFile(tempDir, payload);

    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 0),
        countUnsyncedVectors: vi.fn(() => 0),
      },
      activateSqliteImage: vi.fn(async () => { throw new Error('reload exploded'); }),
      detectAndMarkVectorDrift: vi.fn(),
      reconcileVectorsFromSqlite: vi.fn(),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = createConfig(tempDir);
    const service = new BackupService(config, storage, logger);

    await expect(service.restore(backupPath)).rejects.toThrow('activation failed');
    expect(logger.error).toHaveBeenCalled();
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledWith(undefined, 'restore');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('cleans up restore guard state when guard acquisition fails before activation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-guard-fail');
    const backupPath = makeBackupFile(tempDir, payload);

    const beginLifecycleOperation = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('restore lock busy');
      })
      .mockImplementation(() => {});

    const storage = {
      sqlite: {
        beginLifecycleOperation,
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 2),
        countUnsyncedVectors: vi.fn(() => 0),
      },
      activateSqliteImage: vi.fn(async () => {}),
      detectAndMarkVectorDrift: vi.fn(async () => ({ mode: 'no-drift', driftedCount: 0 })),
      reconcileVectorsFromSqlite: vi.fn(),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const config = createConfig(tempDir);
    const service = new BackupService(config, storage);

    await expect(service.restore(backupPath)).rejects.toThrow('already in progress');

    const secondAttempt = await service.restore(backupPath);
    expect(secondAttempt).toEqual({
      memory_count: 2,
      metadata_activated: true,
      vector_reconciliation: {
        status: 'healthy',
        state: 'reconciled',
        unsynced_vectors: 0,
      },
    });
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledTimes(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails restore when the post-activation memory count does not match the backup header', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-count-mismatch');
    // Header claims 5 memories, but activation reports only 2.
    const backupPath = makeBackupFile(tempDir, payload, { memory_count: 5 });

    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 2),
        countUnsyncedVectors: vi.fn(() => 0),
      },
      activateSqliteImage: vi.fn(async () => {}),
      detectAndMarkVectorDrift: vi.fn(async () => ({ mode: 'no-drift', driftedCount: 0 })),
      reconcileVectorsFromSqlite: vi.fn(),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = createConfig(tempDir);
    const service = new BackupService(config, storage, logger);

    await expect(service.restore(backupPath)).rejects.toThrow(/expected 5 memories/);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'backup_restore_count_mismatch',
      expected_memory_count: 5,
      actual_memory_count: 2,
    }));
    // The vector reconciliation pass never starts, and the lifecycle lock is
    // still released so a later restore attempt is not blocked forever.
    expect(storage.detectAndMarkVectorDrift).not.toHaveBeenCalled();
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledWith(undefined, 'restore');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects an overlapping restore from another service with a retryable conflict', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-3');
    const backupPath = makeBackupFile(tempDir, payload, { memory_count: 1 });

    let resolveReload: (() => void) | null = null;
    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 1),
        countUnsyncedVectors: vi.fn(() => 0),
      },
      activateSqliteImage: vi.fn(() => new Promise<void>((resolve) => {
        resolveReload = resolve;
      })),
      detectAndMarkVectorDrift: vi.fn(async () => ({ mode: 'no-drift', driftedCount: 0 })),
      reconcileVectorsFromSqlite: vi.fn(),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const config = createConfig(tempDir);
    const service = new BackupService(config, storage);
    const otherService = new BackupService(config, storage);

    const first = service.restore(backupPath);
    const second = otherService.restore(backupPath);

    await expect(second).rejects.toMatchObject({ code: 'CONFLICT', retryable: true });

    resolveReload?.();
    await first;

    rmSync(tempDir, { recursive: true, force: true });
  });
});
