import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import { atomicWriteFileSync } from '../storage/sqlite.js';
import type { BackupInfo, RestoreResult, VectorReconciliationStatus } from '../domain/types.js';
import { BrainError, invalidInput, internal } from '../errors/index.js';
import type pino from 'pino';

export class BackupService {
  private backupDir: string;
  private restoreInProgress = false;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private logger?: pino.Logger,
  ) {
    this.backupDir = join(config.data_dir!, 'backups');
  }

  async create(): Promise<BackupInfo> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}.bhgb`;
    const backupPath = join(this.backupDir, filename);

    try {
      const dbData = this.storage.sqlite.exportData();
      const memoryCount = this.storage.sqlite.countMemories();
      const checksum = createHash('sha256').update(dbData).digest('hex');

      // Write backup as a simple format: JSON header + db data
      const header = JSON.stringify({
        version: 1,
        memory_count: memoryCount,
        checksum,
        created_at: new Date().toISOString(),
        embedding_model: this.config.embedding.model,
        embedding_dimensions: this.config.embedding.dimensions,
      });

      const headerBuf = Buffer.from(header, 'utf-8');
      const headerLen = Buffer.alloc(4);
      headerLen.writeUInt32LE(headerBuf.length);

      const backup = Buffer.concat([headerLen, headerBuf, dbData]);
      atomicWriteFileSync(backupPath, backup);

      const sizeBytes = backup.length;

      this.storage.sqlite.insertBackupMeta(backupPath, sizeBytes, memoryCount, checksum);
      this.storage.sqlite.flushIfDirty();

      return {
        path: backupPath,
        size_bytes: sizeBytes,
        memory_count: memoryCount,
        created_at: new Date().toISOString(),
      };
    } catch (err) {
      throw internal(`Backup creation failed: ${(err as Error).message}`);
    }
  }

  list(): BackupInfo[] {
    const dbBackups = this.storage.sqlite.listBackups();
    return dbBackups.map(b => ({
      path: b.path,
      size_bytes: b.size_bytes,
      memory_count: b.memory_count,
      created_at: b.created_at,
    }));
  }

  async restore(backupPath: string): Promise<RestoreResult> {
    if (this.restoreInProgress) {
      throw invalidInput('Backup restore already in progress');
    }

    if (!existsSync(backupPath)) {
      throw invalidInput(`Backup file not found: ${backupPath}`);
    }

    this.restoreInProgress = true;
    this.storage.sqlite.beginLifecycleOperation('restore');
    try {
      this.logger?.info({ event: 'backup_restore_validate', path: backupPath });
      const data = readFileSync(backupPath);
      const headerLen = data.readUInt32LE(0);
      const headerJson = data.subarray(4, 4 + headerLen).toString('utf-8');
      const header = JSON.parse(headerJson) as {
        version: number;
        memory_count: number;
        checksum: string;
      };

      const dbData = data.subarray(4 + headerLen);
      const checksum = createHash('sha256').update(dbData).digest('hex');

      if (checksum !== header.checksum) {
        throw invalidInput('Backup integrity check failed: checksum mismatch');
      }

      // Write restored DB atomically
      const dbPath = this.storage.sqlite.getDatabasePath();
      atomicWriteFileSync(dbPath, dbData);
      this.logger?.info({ event: 'backup_restore_write', path: backupPath, bytes: dbData.length });

      try {
        this.logger?.info({ event: 'backup_restore_activate_start', path: backupPath });
        await this.storage.reloadSqliteFromDisk();
      } catch (err) {
        this.logger?.error({
          event: 'backup_restore_activate_failed',
          path: backupPath,
          error: (err as Error).message,
        });
        throw internal(`Backup restore activation failed: ${(err as Error).message}`);
      }

      const activeCount = this.storage.sqlite.countMemories();
      this.storage.markAllMemoriesVectorSync(false, { allowDuringLifecycle: true });
      await this.storage.clearManagedVectors();
      const vectorReconciliation = await this.reconcileVectorsAfterRestore(activeCount);
      this.logger?.info({
        event: 'backup_restore_complete',
        path: backupPath,
        metadata_activated: true,
        memory_count: activeCount,
        vector_reconciliation_state: vectorReconciliation.state,
        unsynced_vectors: vectorReconciliation.unsynced_vectors,
      });

      return {
        memory_count: activeCount,
        metadata_activated: true,
        vector_reconciliation: vectorReconciliation,
      };
    } catch (err) {
      if (err instanceof BrainError) throw err;
      throw internal(`Backup restore failed: ${(err as Error).message}`);
    } finally {
      this.storage.sqlite.endLifecycleOperation('restore');
      this.restoreInProgress = false;
    }
  }

  private async reconcileVectorsAfterRestore(memoryCount: number): Promise<VectorReconciliationStatus> {
    if (memoryCount === 0) {
      return {
        status: 'healthy',
        state: 'reconciled',
        unsynced_vectors: 0,
      };
    }

    try {
      const result = await this.storage.reconcileVectorsFromSqlite({ batchSize: 100, allowDuringLifecycle: true });
      if (result.remaining > 0) {
        return {
          status: 'degraded',
          state: 'pending',
          unsynced_vectors: result.remaining,
          message: 'Restore activated SQLite metadata, but vector reconciliation is still pending.',
        };
      }
      return {
        status: 'healthy',
        state: 'reconciled',
        unsynced_vectors: 0,
      };
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : 'Restore activated SQLite metadata, but vector reconciliation is still pending.';
      this.logger?.warn?.({
        event: 'backup_restore_vector_reconciliation_pending',
        error: message,
      });
      return {
        status: 'degraded',
        state: 'pending',
        unsynced_vectors: this.storage.sqlite.countUnsyncedVectors(),
        message,
      };
    }
  }
}
