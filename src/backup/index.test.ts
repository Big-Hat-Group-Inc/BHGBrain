import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { BackupService } from './index.js';

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
      },
      reloadSqliteFromDisk: vi.fn(async () => {}),
    } as any;

    const logger = { info: vi.fn(), error: vi.fn() } as any;
    const service = new BackupService({ data_dir: tempDir } as any, storage, logger);

    const result = await service.restore(backupPath);
    expect(result).toEqual({ memory_count: 7, activated: true });
    expect(storage.sqlite.beginLifecycleOperation).toHaveBeenCalledWith('restore');
    expect(storage.sqlite.endLifecycleOperation).toHaveBeenCalledWith('restore');
    expect(storage.reloadSqliteFromDisk).toHaveBeenCalledTimes(1);

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
      },
      reloadSqliteFromDisk: vi.fn(async () => { throw new Error('reload exploded'); }),
    } as any;

    const logger = { info: vi.fn(), error: vi.fn() } as any;
    const service = new BackupService({ data_dir: tempDir } as any, storage, logger);

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
      },
      reloadSqliteFromDisk: vi.fn(() => new Promise<void>((resolve) => {
        resolveReload = resolve;
      })),
    } as any;

    const service = new BackupService({ data_dir: tempDir } as any, storage);

    const first = service.restore(backupPath);
    const second = service.restore(backupPath);

    await expect(second).rejects.toThrow('already in progress');

    resolveReload?.();
    await first;

    rmSync(tempDir, { recursive: true, force: true });
  });
});
