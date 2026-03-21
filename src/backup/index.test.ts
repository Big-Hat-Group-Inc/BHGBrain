import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { BackupService } from './index.js';
import type { BrainConfig } from '../config/index.js';
import type pino from 'pino';
import type { StorageManager } from '../storage/index.js';
import { embeddingUnavailable } from '../errors/index.js';

function makeBackupFile(dir: string, payload: Buffer): string {
  const checksum = createHash('sha256').update(payload).digest('hex');
  const header = Buffer.from(JSON.stringify({ version: 1, memory_count: 2, checksum }), 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  const data = Buffer.concat([len, header, payload]);
  const path = join(dir, 'sample.bhgb');
  writeFileSync(path, data);
  return path;
}

describe('BackupService restore activation', () => {
  it('reloads sqlite and reports activated on restore', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-1');
    const backupPath = makeBackupFile(tempDir, payload);

    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 7),
        countUnsyncedVectors: vi.fn(() => 0),
      },
      reloadSqliteFromDisk: vi.fn(async () => {}),
      markAllMemoriesVectorSync: vi.fn(() => 7),
      clearManagedVectors: vi.fn(async () => 2),
      reconcileVectorsFromSqlite: vi.fn(async () => ({ reconciled: 7, remaining: 0 })),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = { data_dir: tempDir } as unknown as BrainConfig;
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
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledWith('restore');
    expect(storage.reloadSqliteFromDisk).toHaveBeenCalledTimes(1);
    expect(storage.markAllMemoriesVectorSync).toHaveBeenCalledWith(false, { allowDuringLifecycle: true });
    expect(storage.clearManagedVectors).toHaveBeenCalledTimes(1);
    expect(storage.reconcileVectorsFromSqlite).toHaveBeenCalledWith({ batchSize: 100, allowDuringLifecycle: true });

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports pending vector reconciliation when embeddings are unavailable after activation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-pending');
    const backupPath = makeBackupFile(tempDir, payload);

    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 4),
        countUnsyncedVectors: vi.fn(() => 4),
      },
      reloadSqliteFromDisk: vi.fn(async () => {}),
      markAllMemoriesVectorSync: vi.fn(() => 4),
      clearManagedVectors: vi.fn(async () => 1),
      reconcileVectorsFromSqlite: vi.fn(async () => {
        throw embeddingUnavailable('Embedding provider is unavailable: missing API credentials');
      }),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = { data_dir: tempDir } as unknown as BrainConfig;
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
      reloadSqliteFromDisk: vi.fn(async () => { throw new Error('reload exploded'); }),
      markAllMemoriesVectorSync: vi.fn(),
      clearManagedVectors: vi.fn(),
      reconcileVectorsFromSqlite: vi.fn(),
    } as unknown as StorageManager;

    const logger = { info: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
    const config = { data_dir: tempDir } as unknown as BrainConfig;
    const service = new BackupService(config, storage, logger);

    await expect(service.restore(backupPath)).rejects.toThrow('activation failed');
    expect(logger.error).toHaveBeenCalled();
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledWith('restore');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serializes concurrent restore requests', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-3');
    const backupPath = makeBackupFile(tempDir, payload);

    let resolveReload: (() => void) | null = null;
    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 1),
        countUnsyncedVectors: vi.fn(() => 0),
      },
      reloadSqliteFromDisk: vi.fn(() => new Promise<void>((resolve) => {
        resolveReload = resolve;
      })),
      markAllMemoriesVectorSync: vi.fn(() => 1),
      clearManagedVectors: vi.fn(async () => 1),
      reconcileVectorsFromSqlite: vi.fn(async () => ({ reconciled: 1, remaining: 0 })),
    } as unknown as StorageManager;

    const config = { data_dir: tempDir } as unknown as BrainConfig;
    const service = new BackupService(config, storage);

    const first = service.restore(backupPath);
    const second = service.restore(backupPath);

    await expect(second).rejects.toThrow('already in progress');

    resolveReload?.();
    await first;

    rmSync(tempDir, { recursive: true, force: true });
  });
});
