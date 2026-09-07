import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
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
    const exportBody = Buffer.from('sqlite-image');
    const exportPath = join(tempDir, '.brain-export-test.sqlite');
    const storage = {
      sqlite: {
        // Task 1.4: `create()` streams from the file `exportDataToFile`
        // hands back (never reading a whole-database buffer itself), so the
        // mock writes a real file, mirroring the production contract.
        exportDataToFile: vi.fn(() => {
          writeFileSync(exportPath, exportBody);
          return { path: exportPath, sizeBytes: exportBody.length };
        }),
        countMemories: vi.fn(() => 3),
        insertBackupMeta: vi.fn(),
        flushIfDirty: vi.fn(),
      },
    } as unknown as StorageManager;

    const result = await new BackupService(createConfig(tempDir), storage).create();
    const image = readFileSync(result.path);
    const headerLength = image.readUInt32LE(0);
    const header = JSON.parse(image.subarray(4, 4 + headerLength).toString('utf8')) as Record<string, unknown>;
    const body = image.subarray(4 + headerLength);

    expect(header).toEqual(expect.objectContaining({
      version: 2, memory_count: 3, checksum: expect.any(String), header_checksum: expect.any(String),
    }));
    expect(body.equals(exportBody)).toBe(true);
    expect(statSync(result.path).mode & 0o077).toBe(0);
    expect(readdirSync(join(tempDir, 'backups')).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(storage.sqlite.insertBackupMeta).toHaveBeenCalledWith(
      result.path, image.length, 3, expect.any(String),
    );
    // The scratch export file is cleaned up once streamed into the backup.
    expect(existsSync(exportPath)).toBe(false);

    rmSync(tempDir, { recursive: true, force: true });
  });

  // Task 1.4: backup creation must stream hashing and output rather than
  // concatenating whole buffers. Two complementary checks: (1) a behavioral
  // one — the destination file is written in many small chunks, not one
  // giant write, proving the body is actually streamed rather than
  // Buffer.concat-ed; (2) a coarse peak-memory guard — heap growth while
  // streaming a many-times-larger-than-chunk-size export stays a small
  // fraction of the export size, rather than scaling with it.
  it('streams a large export in bounded chunks instead of buffering it whole', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    mkdirSync(join(tempDir, 'backups'));
    const exportSizeBytes = 20 * 1024 * 1024; // 20 MiB — far larger than any single write chunk.
    const exportPath = join(tempDir, '.brain-export-large.sqlite');
    // Not literally a SQLite file — `create()` doesn't parse the export, it
    // only streams its bytes through hashing and disk output.
    writeFileSync(exportPath, Buffer.alloc(exportSizeBytes, 7));

    const storage = {
      sqlite: {
        exportDataToFile: vi.fn(() => ({ path: exportPath, sizeBytes: exportSizeBytes })),
        countMemories: vi.fn(() => 1),
        insertBackupMeta: vi.fn(),
        flushIfDirty: vi.fn(),
      },
    } as unknown as StorageManager;

    let peakHeapDeltaBytes = 0;
    const baselineHeapBytes = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => {
      const delta = process.memoryUsage().heapUsed - baselineHeapBytes;
      if (delta > peakHeapDeltaBytes) peakHeapDeltaBytes = delta;
    }, 1);

    let result: Awaited<ReturnType<BackupService['create']>>;
    try {
      result = await new BackupService(createConfig(tempDir), storage).create();
    } finally {
      clearInterval(sampler);
    }

    expect(result.size_bytes).toBeGreaterThanOrEqual(exportSizeBytes);
    expect(statSync(result.path).size).toBe(result.size_bytes);
    // Coarse guard: peak heap growth stays a small fraction of the 20 MiB
    // export (a whole-buffer implementation would need to hold at least one
    // full copy — 20 MiB+ — of it at once; this stays well under that).
    expect(peakHeapDeltaBytes).toBeLessThan(exportSizeBytes / 4);

    rmSync(tempDir, { recursive: true, force: true });
  }, 30_000);

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
      deviceId: null,
    });
    expect(storage.reconcileVectorsFromSqlite).not.toHaveBeenCalled();
    expect(storage.setBackgroundReconciliationActive).not.toHaveBeenCalled();

    rmSync(tempDir, { recursive: true, force: true });
  });

  // Task 3.2: unresolved vector-only orphan work (a surplus delete that
  // failed) must keep the restore result degraded/retryable even when there
  // is zero SQLite-side drift — "semantic readiness" is not healthy while
  // an orphan can still surface via the cross-device search fallback.
  it('stays degraded when zero drift but a vector-only surplus point failed to prune', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-surplus-remaining');
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
      detectAndMarkVectorDrift: vi.fn(async () => ({ mode: 'no-drift', driftedCount: 0, surplusPruned: 0, surplusRemaining: 2 })),
      reconcileVectorsFromSqlite: vi.fn(async () => ({ reconciled: 0, remaining: 0, boundReached: false })),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const config = createConfig(tempDir);
    const service = new BackupService(config, storage);

    const result = await service.restore(backupPath);

    expect(result.vector_reconciliation.status).toBe('degraded');
    expect(result.vector_reconciliation.state).toBe('reconciling');
    expect(result.vector_reconciliation.message).toMatch(/2 vector-only orphan point\(s\)/);
    // No SQLite-side drift, so no background re-embed is scheduled — the
    // remaining work is a Qdrant-side delete retry, not a re-embed.
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

  // Task 3.3: a transient Qdrant read outage during drift detection must
  // never be reported to the caller as "the embedding model changed" — the
  // two are different outcomes (`detectAndMarkVectorDrift` names them
  // 'inspection-failed' vs. 'full-rebuild') and the restore result's message
  // must not collapse them.
  it('reports a distinct message for an inspection failure, not the embedding-model-changed message', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const payload = Buffer.from('db-bytes-inspection-failed');
    const backupPath = makeBackupFile(tempDir, payload, { memory_count: 3 });

    const storage = {
      sqlite: {
        beginLifecycleOperation: vi.fn(),
        endLifecycleOperation: vi.fn(),
        getDatabasePath: vi.fn(() => join(tempDir, 'brain.db')),
        countMemories: vi.fn(() => 3),
        countUnsyncedVectors: vi.fn(() => 3),
      },
      activateSqliteImage: vi.fn(async () => {}),
      detectAndMarkVectorDrift: vi.fn(async () => ({ mode: 'inspection-failed', driftedCount: 3 })),
      reconcileVectorsFromSqlite: vi.fn(async () => ({ reconciled: 3, remaining: 0, boundReached: false })),
      setBackgroundReconciliationActive: vi.fn(),
    } as unknown as StorageManager;

    const config = createConfig(tempDir);
    const service = new BackupService(config, storage);

    const result = await service.restore(backupPath);

    expect(result.vector_reconciliation.message).not.toMatch(/embedding model or dimensions changed/);
    expect(result.vector_reconciliation).toEqual({
      status: 'degraded',
      state: 'reconciling',
      unsynced_vectors: 3,
      message: 'Restore activated SQLite metadata; the vector store could not be inspected for drift ' +
        '(a transient failure, not a model change), so reconciliation is conservatively re-embedding the ' +
        'corpus in the background.',
    });

    await flushMicrotasks();

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
      deviceId: null,
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

  it('stop() cancels a pending background-reconciliation retry timer so it never fires against a closed store (align-runtime-entrypoint-contracts task 3.3)', async () => {
    vi.useFakeTimers();
    try {
      const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
      const payload = Buffer.from('db-bytes-stop');
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
        // Always reports remaining work, so an uncancelled timer would keep retrying.
        reconcileVectorsFromSqlite: vi.fn(async () => ({ reconciled: 0, remaining: 4, boundReached: true })),
        setBackgroundReconciliationActive: vi.fn(),
      } as unknown as StorageManager;

      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;
      const config = createConfig(tempDir);
      const service = new BackupService(config, storage, logger);

      await service.restore(backupPath);
      await vi.advanceTimersByTimeAsync(0);
      expect(storage.reconcileVectorsFromSqlite).toHaveBeenCalledTimes(1);

      // Simulate process shutdown: stop() runs (per createShutdown in
      // src/index.ts) before sqlite.close() — the pending retry timer
      // scheduled by the first attempt above must never fire afterward.
      service.stop();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(storage.reconcileVectorsFromSqlite).toHaveBeenCalledTimes(1);

      rmSync(tempDir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() is safe to call when no reconciliation was ever scheduled', () => {
    const config = { data_dir: '/tmp' } as unknown as BrainConfig;
    const storage = {} as unknown as StorageManager;
    const service = new BackupService(config, storage);

    expect(() => service.stop()).not.toThrow();
    expect(() => service.stop()).not.toThrow();
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
        resolveReload = () => resolve();
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

    (resolveReload as (() => void) | null)?.();
    await first;

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// Task 3.4: backup file retention (count/age), coordinated with metadata
// cleanup, distinct from memory-level `retention` config.
describe('BackupService backup file retention', () => {
  function backupConfig(tempDir: string, retention?: { max_count?: number | null; max_age_days?: number | null }): BrainConfig {
    return {
      data_dir: tempDir,
      embedding: { model: 'test-model', dimensions: 3 },
      backup: { retention: { max_count: null, max_age_days: null, ...retention } },
    } as unknown as BrainConfig;
  }

  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  }

  it('list() flags a backup whose file is gone as missing, without touching its metadata', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const presentPath = join(tempDir, 'present.bhgb');
    writeFileSync(presentPath, 'x');
    const missingPath = join(tempDir, 'gone.bhgb'); // never created on disk

    const storage = {
      sqlite: {
        listBackups: vi.fn(() => [
          { path: presentPath, size_bytes: 1, memory_count: 1, created_at: daysAgo(0) },
          { path: missingPath, size_bytes: 1, memory_count: 1, created_at: daysAgo(1) },
        ]),
      },
    } as unknown as StorageManager;

    const result = new BackupService(backupConfig(tempDir), storage).list();

    expect(result).toEqual([
      expect.objectContaining({ path: presentPath, missing: false }),
      expect.objectContaining({ path: missingPath, missing: true }),
    ]);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('pruneRetention() deletes backups beyond max_count and their metadata together', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const paths = ['a', 'b', 'c'].map(name => join(tempDir, `${name}.bhgb`));
    for (const p of paths) writeFileSync(p, 'x');

    const deleteBackupMeta = vi.fn();
    const storage = {
      sqlite: {
        // Newest-first, matching listBackups()'s real ORDER BY created_at DESC.
        listBackups: vi.fn(() => [
          { path: paths[0], size_bytes: 1, memory_count: 1, created_at: daysAgo(0) },
          { path: paths[1], size_bytes: 1, memory_count: 1, created_at: daysAgo(1) },
          { path: paths[2], size_bytes: 1, memory_count: 1, created_at: daysAgo(2) },
        ]),
        deleteBackupMeta,
        flushIfDirty: vi.fn(),
      },
    } as unknown as StorageManager;

    const result = new BackupService(backupConfig(tempDir, { max_count: 2 }), storage).pruneRetention();

    expect(result).toEqual({ pruned: [paths[2]], missingFlagged: [], failed: [] });
    expect(existsSync(paths[0])).toBe(true);
    expect(existsSync(paths[1])).toBe(true);
    expect(existsSync(paths[2])).toBe(false);
    expect(deleteBackupMeta).toHaveBeenCalledWith(paths[2]);
    expect(deleteBackupMeta).toHaveBeenCalledTimes(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('pruneRetention() deletes backups older than max_age_days regardless of count', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const freshPath = join(tempDir, 'fresh.bhgb');
    const oldPath = join(tempDir, 'old.bhgb');
    writeFileSync(freshPath, 'x');
    writeFileSync(oldPath, 'x');

    const deleteBackupMeta = vi.fn();
    const storage = {
      sqlite: {
        listBackups: vi.fn(() => [
          { path: freshPath, size_bytes: 1, memory_count: 1, created_at: daysAgo(1) },
          { path: oldPath, size_bytes: 1, memory_count: 1, created_at: daysAgo(100) },
        ]),
        deleteBackupMeta,
        flushIfDirty: vi.fn(),
      },
    } as unknown as StorageManager;

    const result = new BackupService(backupConfig(tempDir, { max_age_days: 90 }), storage).pruneRetention();

    expect(result).toEqual({ pruned: [oldPath], missingFlagged: [], failed: [] });
    expect(existsSync(freshPath)).toBe(true);
    expect(existsSync(oldPath)).toBe(false);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('pruneRetention() flags a beyond-bound backup whose file is already gone and still cleans up its metadata', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const goneePath = join(tempDir, 'gone.bhgb'); // never created

    const deleteBackupMeta = vi.fn();
    const storage = {
      sqlite: {
        listBackups: vi.fn(() => [
          { path: goneePath, size_bytes: 1, memory_count: 1, created_at: daysAgo(0) },
        ]),
        deleteBackupMeta,
        flushIfDirty: vi.fn(),
      },
    } as unknown as StorageManager;

    const result = new BackupService(backupConfig(tempDir, { max_count: 0 }), storage).pruneRetention();

    expect(result).toEqual({ pruned: [], missingFlagged: [goneePath], failed: [] });
    expect(deleteBackupMeta).toHaveBeenCalledWith(goneePath);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('pruneRetention() leaves metadata in place for a backup whose file delete fails, so it is retried later', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    // A directory (not a plain file) at this path makes unlinkSync fail with EISDIR/EPERM.
    const undeletablePath = join(tempDir, 'locked.bhgb');
    mkdirSync(undeletablePath);

    const deleteBackupMeta = vi.fn();
    const storage = {
      sqlite: {
        listBackups: vi.fn(() => [
          { path: undeletablePath, size_bytes: 1, memory_count: 1, created_at: daysAgo(0) },
        ]),
        deleteBackupMeta,
        flushIfDirty: vi.fn(),
      },
    } as unknown as StorageManager;

    const result = new BackupService(backupConfig(tempDir, { max_count: 0 }), storage).pruneRetention();

    expect(result).toEqual({ pruned: [], missingFlagged: [], failed: [undeletablePath] });
    expect(deleteBackupMeta).not.toHaveBeenCalled();
    expect(existsSync(undeletablePath)).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does nothing when both bounds are null (default off)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    const p = join(tempDir, 'a.bhgb');
    writeFileSync(p, 'x');

    const deleteBackupMeta = vi.fn();
    const storage = {
      sqlite: {
        listBackups: vi.fn(() => [{ path: p, size_bytes: 1, memory_count: 1, created_at: daysAgo(1000) }]),
        deleteBackupMeta,
        flushIfDirty: vi.fn(),
      },
    } as unknown as StorageManager;

    const result = new BackupService(backupConfig(tempDir), storage).pruneRetention();

    expect(result).toEqual({ pruned: [], missingFlagged: [], failed: [] });
    expect(deleteBackupMeta).not.toHaveBeenCalled();
    expect(existsSync(p)).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('create() prunes retention automatically after a successful backup', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    mkdirSync(join(tempDir, 'backups'));
    const staleBackupPath = join(tempDir, 'backups', 'stale.bhgb');
    writeFileSync(staleBackupPath, 'x');
    const exportPath = join(tempDir, '.brain-export-retention.sqlite');

    const deleteBackupMeta = vi.fn();
    const storage = {
      sqlite: {
        exportDataToFile: vi.fn(() => {
          writeFileSync(exportPath, Buffer.from('sqlite-image'));
          return { path: exportPath, sizeBytes: 12 };
        }),
        countMemories: vi.fn(() => 1),
        insertBackupMeta: vi.fn(),
        flushIfDirty: vi.fn(),
        listBackups: vi.fn(() => [
          { path: 'new-backup-placeholder', size_bytes: 1, memory_count: 1, created_at: daysAgo(0) },
          { path: staleBackupPath, size_bytes: 1, memory_count: 1, created_at: daysAgo(1) },
        ]),
        deleteBackupMeta,
      },
    } as unknown as StorageManager;

    await new BackupService(backupConfig(tempDir, { max_count: 1 }), storage).create();

    expect(existsSync(staleBackupPath)).toBe(false);
    expect(deleteBackupMeta).toHaveBeenCalledWith(staleBackupPath);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a retention pass failure never fails an otherwise-successful create()', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-backup-test-'));
    mkdirSync(join(tempDir, 'backups'));
    const exportPath = join(tempDir, '.brain-export-retention-fail.sqlite');

    const storage = {
      sqlite: {
        exportDataToFile: vi.fn(() => {
          writeFileSync(exportPath, Buffer.from('sqlite-image'));
          return { path: exportPath, sizeBytes: 12 };
        }),
        countMemories: vi.fn(() => 1),
        insertBackupMeta: vi.fn(),
        flushIfDirty: vi.fn(),
        listBackups: vi.fn(() => { throw new Error('metadata store unavailable'); }),
      },
    } as unknown as StorageManager;

    const result = await new BackupService(backupConfig(tempDir, { max_count: 1 }), storage).create();

    expect(result.path).toBeDefined();
    expect(existsSync(result.path)).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
